import os
import io
import re
import json
import math
import zipfile
import argparse
import tempfile
from pathlib import Path
from typing import List, Dict, Any

import requests  # pour appeler le GAS

# --- Audio utils ---
from pydub import AudioSegment

# --- WhisperX ---
import torch
import whisperx

# --- OpenAI ---
from openai import OpenAI
client = OpenAI()  # client global

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

# =========================
# Prompt loader (depuis GAS)
# =========================

def fetch_prompt(gas_url: str, doc_id: str) -> str:
    url = f"{gas_url}?docId={doc_id}"
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    return r.text.strip()

# =========================
# 1) Unzip & Concat
# =========================

def unzip_and_concat(zip_path: str, silence_sec: float = 10.0) -> Dict[str, Any]:
    out_dir = Path(tempfile.mkdtemp(prefix="whx_zip_"))
    with zipfile.ZipFile(zip_path, 'r') as zf:
        zf.extractall(out_dir)

    mp3_files = sorted([p for p in out_dir.rglob("*.mp3")], key=lambda p: str(p).lower())
    if not mp3_files:
        raise FileNotFoundError("Aucun MP3 trouvé dans le ZIP.")

    silence = AudioSegment.silent(duration=int(silence_sec * 1000))
    timeline_map = []
    concat = AudioSegment.silent(duration=0)

    cursor_ms = 0
    for i, mp3 in enumerate(mp3_files):
        seg = AudioSegment.from_file(mp3, format="mp3")
        start_ms = cursor_ms
        concat += seg
        cursor_ms += len(seg)

        timeline_map.append({
            "file": str(mp3),
            "start": start_ms / 1000.0,
            "end": cursor_ms / 1000.0
        })

        if i != len(mp3_files) - 1:
            concat += silence
            cursor_ms += len(silence)

    concat_path = str(out_dir / "concatenated_input.mp3")
    concat.export(concat_path, format="mp3")

    return {
        "concat_path": concat_path,
        "total_input_duration": cursor_ms / 1000.0,
        "file_map": timeline_map,
        "workdir": str(out_dir)
    }

# =========================
# 2) WhisperX word-level
# =========================

def transcribe_wordlevel_whisperx(audio_path: str) -> Dict[str, Any]:
    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = "float16" if device == "cuda" else "float32"
    print(f"[INFO] WhisperX sur {device} (compute={compute_type})")

    model = whisperx.load_model("small", device, compute_type=compute_type)
    result = model.transcribe(audio_path, batch_size=16)

    model_a, metadata = whisperx.load_align_model(language_code=result["language"], device=device)
    result_aligned = whisperx.align(
        result["segments"], model_a, metadata, audio_path, device, return_char_alignments=False
    )
    return result_aligned

# =========================
# 2.5) Agréger mots -> segments
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
# 3) Appel GPT : score des segments
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
# 3.5) Sélection jusqu'à la durée cible
# =========================

def select_segments_to_target(scored_segments, target_seconds: float):
    ss = sorted(scored_segments, key=lambda s: (s.get("score", 0.0), s["end"] - s["start"]), reverse=True)
    selected = []
    total = 0.0
    for seg in ss:
        dur = seg["end"] - seg["start"]
        if total + dur <= target_seconds * 1.03:
            selected.append({"start": seg["start"], "end": seg["end"], "label": seg.get("label", "")})
            total += dur
        if total >= target_seconds:
            break
    merged = []
    for seg in sorted(selected, key=lambda x: x["start"]):
        if not merged:
            merged.append(seg)
            continue
        if seg["start"] - merged[-1]["end"] < 0.2:
            merged[-1]["end"] = max(merged[-1]["end"], seg["end"])
            merged[-1]["label"] = (merged[-1]["label"] + " | " + seg.get("label", "")).strip(" |")
        else:
            merged.append(seg)
    return merged

# =========================
# 4) Construire le best-of audio
# =========================

def build_bestof_audio(concat_mp3_path: str, clips, out_path: str) -> float:
    base = AudioSegment.from_file(concat_mp3_path, format="mp3")
    bestof = AudioSegment.silent(duration=0)
    for c in clips:
        start_ms = int(c["start"] * 1000)
        end_ms = int(c["end"] * 1000)
        if end_ms > len(base):
            end_ms = len(base)
        if start_ms < 0 or start_ms >= end_ms:
            continue
        bestof += base[start_ms:end_ms]
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    bestof.export(out_path, format="mp3")
    return len(bestof) / 1000.0

# =========================
# Main
# =========================

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("zip_path")
    parser.add_argument("--keep_pct", type=float, default=20.0)
    parser.add_argument("--silence_between", type=float, default=10.0)
    parser.add_argument("--openai_model", default="gpt-4o-mini")
    parser.add_argument("--out_dir", default="bestof_out")
    parser.add_argument("--gas_url", required=True, help="URL du script GAS (WebApp)")
    parser.add_argument("--doc_id", required=True, help="ID du Google Doc contenant le prompt")
    args = parser.parse_args()

    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY manquant.")

    # Charger le prompt depuis Google Doc via GAS
    system_prompt = fetch_prompt(args.gas_url, args.doc_id)
    print(f"[INFO] Prompt système chargé ({len(system_prompt)} chars)")

    concat_info = unzip_and_concat(args.zip_path, silence_sec=args.silence_between)
    concat_mp3 = concat_info["concat_path"]
    total_input = concat_info["total_input_duration"]
    print(f"[INFO] Concat terminé: {concat_mp3} ({human_time(total_input)})")

    aligned = transcribe_wordlevel_whisperx(concat_mp3)
    words = aligned.get("word_segments", [])
    if not words:
        raise RuntimeError("Pas de word_segments")

    segments = words_to_segments(words)
    print(f"[INFO] Segments générés: {len(segments)}")

    scored = score_all_segments_with_gpt(segments, args.openai_model, system_prompt)
    keep_ratio = max(0.0, min(1.0, args.keep_pct / 100.0))
    target_seconds = total_input * keep_ratio
    chosen = select_segments_to_target(scored, target_seconds)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    clips_json_path = str(out_dir / "clips_selected.json")
    with open(clips_json_path, "w", encoding="utf-8") as f:
        json.dump({"clips": chosen}, f, ensure_ascii=False, indent=2)

    bestof_mp3 = str(out_dir / "bestof.mp3")
    best_dur = build_bestof_audio(concat_mp3, chosen, bestof_mp3)

    print(f"=== Résultat ===\nBest-of : {bestof_mp3} ({human_time(best_dur)})")

if __name__ == "__main__":
    main()
