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
    aligned = whisperx.align(
        result["segments"], align_model, metadata, str(path), device, return_char_alignments=False
    )
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
            "-i", str(src),
            "-vn",
            "-c:a", "libmp3lame", "-q:a", "2",
            str(part),
        ]
        run_ffmpeg(cmd)
        part_files.append(part)

    # Create concat list
    list_file = tempdir / "concat.txt"
    with open(list_file, "w", encoding="utf-8") as f:
        for pf in part_files:
            f.write(f"file '{pf.as_posix()}'\n")

    # Concatenate without re-encoding
    cmd_concat = [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0",
        "-i", str(list_file),
        "-c", "copy",
        out_path,
    ]
    run_ffmpeg(cmd_concat)

# =========================
# Main
# =========================

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("zip_path")
    parser.add_argument("--keep_pct", type=float, default=20.0)
    parser.add_argument("--openai_model", default="gpt-4o-mini")
    parser.add_argument("--out_dir", default="bestof_out")
    parser.add_argument("--gas_url", required=True)
    parser.add_argument("--doc_id", required=True)
    parser.add_argument("--whisperx_model", default="small", help="tiny|base|small|medium|large-v2")
    parser.add_argument("--device", default=("cuda" if torch.cuda.is_available() else "cpu"))
    parser.add_argument("--compute_type", default=None, help="float16|float32 (default auto)")
    parser.add_argument("--batch_size", type=int, default=8)
    args = parser.parse_args()

    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY manquant.")

    # Be conservative with CPU threads (helps RAM too)
    try:
        torch.set_num_threads(max(1, int(os.environ.get("PYTORCH_NUM_THREADS", "1"))))
    except Exception:
        pass

    compute_type = args.compute_type or ("float16" if args.device == "cuda" else "float32")

    # Charger le prompt depuis Google Doc via GAS
    system_prompt = fetch_prompt(args.gas_url, args.doc_id)
    print(f"[INFO] Prompt système chargé ({len(system_prompt)} chars)")

    # Unzip only
    mp3_files = unzip_mp3s(args.zip_path)
    print(f"[INFO] Fichiers audio: {len(mp3_files)}")

    # Load models once
    asr_model, align_model, metadata = load_whisperx_models(args.device, compute_type, args.whisperx_model)

    all_segments = []
    total_input = 0.0

    # Transcribe each file independently (low memory)
    for f in mp3_files:
        print(f"[INFO] Transcription: {f.name}")
        aligned = transcribe_one_file(f, asr_model, align_model, metadata, args.device, args.batch_size)
        words = aligned.get("word_segments", [])
        if not words:
            print(f"[WARN] Pas de word_segments pour {f}")
            continue
        file_segments = words_to_segments(words)
        # Tag with source file, keep local timestamps
        for s in file_segments:
            s["file"] = str(f)
        # Track total input duration (use file duration)
        try:
            dur = AudioSegment.from_file(f, format="mp3").duration_seconds
        except Exception:
            dur = max((seg["end"] for seg in file_segments), default=0.0)
        total_input += float(dur)
        all_segments.extend(file_segments)

    if not all_segments:
        raise RuntimeError("Aucun segment détecté sur l'ensemble des fichiers.")

    print(f"[INFO] Segments générés: {len(all_segments)}")

    # Score with GPT in batches
    scored = score_all_segments_with_gpt(all_segments, args.openai_model, system_prompt)

    keep_ratio = max(0.0, min(1.0, args.keep_pct / 100.0))
    target_seconds = total_input * keep_ratio
    chosen = select_segments_to_target(scored, target_seconds)

    # Save chosen clips (file + local timestamps)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    clips_json_path = str(out_dir / "clips_selected.json")
    with open(clips_json_path, "w", encoding="utf-8") as f:
        json.dump({"clips": [
            {"file": c["file"], "start": c["start"], "end": c["end"], "label": c.get("label", ""), "score": c.get("score", 0.0)}
            for c in chosen
        ]}, f, ensure_ascii=False, indent=2)

    # Cut and concat with ffmpeg (streamed)
    bestof_mp3 = str(out_dir / "bestof.mp3")
    if chosen:
        cut_and_concat_with_ffmpeg(chosen, bestof_mp3)
        # Compute resulting duration quickly
        try:
            bo_dur = AudioSegment.from_file(bestof_mp3, format="mp3").duration_seconds
        except Exception:
            # fallback if pydub probing fails
            bo_dur = sum((c["end"] - c["start"]) for c in chosen)
    else:
        bo_dur = 0.0

    print(f"=== Résultat ===\nBest-of : {bestof_mp3} ({human_time(bo_dur)})")

if __name__ == "__main__":
    main()
