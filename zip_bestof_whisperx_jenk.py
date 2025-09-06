import os
import io
import re
import json
import math
import zipfile
import argparse
import tempfile
import subprocess
from pathlib import Path
from typing import List, Dict, Any, Tuple

import requests

# --- Audio utils (only to probe durations if needed) ---
from pydub import AudioSegment

# --- WhisperX ---
import torch
import whisperx

# --- OpenAI ---
from openai import OpenAI
client = OpenAI()  # global client

# =========================
# Utils
# =========================

def human_time(sec: float) -> str:
    sec = max(0, float(sec))
    m, s = divmod(sec, 60)
    h, m = divmod(int(m), 60)
    if h:
        return f"{h:d}:{m:02d}:{s:05.2f}"
    else:
        return f"{m:d}:{s:05.2f}"

def run_ffmpeg(cmd: List[str]):
    # Fail fast with readable error
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {' '.join(cmd)}\n{p.stderr}")
    return p

# =========================
# Prompt loader (depuis GAS)
# =========================

def fetch_prompt(gas_url: str, doc_id: str) -> str:
    url = f"{gas_url}?docId={doc_id}"
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    return r.text.strip()

# =========================
# 1) Unzip (no concat)
# =========================

def unzip_mp3s(zip_path: str) -> List[Path]:
    out_dir = Path(tempfile.mkdtemp(prefix="whx_zip_"))
    with zipfile.ZipFile(zip_path, 'r') as zf:
        zf.extractall(out_dir)
    mp3_files = sorted([p for p in out_dir.rglob("*.mp3")], key=lambda p: str(p).lower())
    if not mp3_files:
        raise FileNotFoundError("Aucun MP3 trouvé dans le ZIP.")
    return mp3_files

# =========================
# 2) WhisperX per-file
# =========================

def load_whisperx_models(device: str, compute_type: str, whisperx_model: str):
    print(f"[INFO] WhisperX sur {device} (compute={compute_type}, model={whisperx_model})")
    asr_model = whisperx.load_model(whisperx_model, device, compute_type=compute_type)
    align_model, metadata = whisperx.load_align_model(language_code=None, device=device)
    return asr_model, align_model, metadata

def transcribe_one_file(path: Path, asr_model, align_model, metadata, device: str, batch_size: int) -> Dict[str, Any]:
    # Transcribe this file only
    result = asr_model.transcribe(str(path), batch_size=batch_size)
    # result["language"] might be None until alignment; try from segments if available
    lang = result.get("language")
    aligned = whisperx.align(result["segments"], align_model, metadata, str(path), device, return_char_alignments=False)
    # aligned has "word_segments"
    return aligned

# =========================
# 2.5) words -> segments (carry file info)
# =========================

def words_to_segments(word_segments: List[Dict[str, Any]], max_gap: float = 0.6, max_chars: int = 300) -> List[Dict[str, Any]]:
    segs = []
    cur_words = []
    cur_start = None
    last_end = None

    def flush_segment():
        nonlocal cur_words, cur_start, last_end
        if cur_words:
            txt = " ".join(w["word"] for w in cur_words)
            segs.append({
                "start": float(cur_start),
                "end": float(last_end),
                "text": txt.strip()
            })
        cur_words = []
        cur_start = None
        last_end = None

    for w in word_segments:
        w_start, w_end, w_text = float(w["start"]), float(w["end"]), w["word"]
        if cur_start is None:
            cur_start = w_start
            last_end = w_end
            cur_words = [w]
            continue

        gap = w_start - last_end
        too_long = len(" ".join(x["word"] for x in cur_words)) > max_chars

        if gap > max_gap or too_long:
            flush_segment()
            cur_start = w_start
            last_end = w_end
            cur_words = [w]
        else:
            cur_words.append(w)
            last_end = w_end

    flush_segment()
    for i, s in enumerate(segs):
        s["i"] = i
    return segs

# =========================
# 3) GPT scoring (unchanged)
# =========================

def openai_score_segments(segments, model: str, system_prompt: str):
    payload_segments = [
        {"i": s["i"], "start": round(s["start"], 2), "end": round(s["end"], 2), "text": s["text"][:3000]}
        for s in segments
    ]
    user_prompt = (
        "Analyse et score les segments suivants :\n"
        f"{json.dumps(payload_segments, ensure_ascii=False)}"
    )

    completion = client.chat.completions.create(
        model=model,
        temperature=0.0,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
    )
    content = completion.choices[0].message.content
    try:
        data = json.loads(content)
        return data.get("scores", [])
    except Exception:
        return []

def batched(iterable, n):
    batch = []
    for x in iterable:
        batch.append(x)
        if len(batch) == n:
            yield batch
            batch = []
    if batch:
        yield batch

def score_all_segments_with_gpt(segments, model: str, system_prompt: str, batch_size: int = 150):
    all_scores = []
    for batch in batched(segments, batch_size):
        scores = openai_score_segments(batch, model=model, system_prompt=system_prompt)
        all_scores.extend(scores)
    score_map = {int(s["i"]): {"score": float(s.get("score", 0.0)), "label": s.get("label", "")} for s in all_scores if "i" in s}
    out = []
    for s in segments:
        meta = score_map.get(s["i"], {"score": 0.0, "label": ""})
        out.append({**s, **meta})
    return out

# =========================
# 3.5) Select to target
# =========================

def select_segments_to_target(scored_segments, target_seconds: float):
    ss = sorted(scored_segments, key=lambda s: (s.get("score", 0.0), s["end"] - s["start"]), reverse=True)
    selected = []
    total = 0.0
    for seg in ss:
        dur = seg["end"] - seg["start"]
        if total + dur <= target_seconds * 1.03:
            selected.append(seg)
            total += dur
        if total >= target_seconds:
            break
    return selected

# =========================
# 4) Build best-of using ffmpeg (no big buffers)
# =========================

def cut_and_concat_with_ffmpeg(clips: List[Dict[str, Any]], out_path: str):
    tempdir = Path(tempfile.mkdtemp(prefix="whx_cuts_"))
    part_files = []
    # Cut each clip as its own small mp3, re-encode for accurate trims
    for idx, c in enumerate(clips):
        src = Path(c["file"])
        ss = max(0.0, float(c["start"]))
        to = max(ss, float(c["end"]))
        part = tempdir / f"part_{idx:05d}.mp3"
        cmd = [
            "ffmpeg", "-y",
            "-ss", f"{ss:.3f}",
            "-to", f"{to:.3f}",
