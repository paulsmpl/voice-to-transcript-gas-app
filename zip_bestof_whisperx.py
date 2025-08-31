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

# --- Audio utils ---
from pydub import AudioSegment

# --- WhisperX ---
import torch
import whisperx

# --- OpenAI (Chat Completions style pour compatibilité large) ---
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
# 1) Unzip & Concat
# =========================

def unzip_and_concat(zip_path: str, silence_sec: float = 10.0) -> Dict[str, Any]:
    """
    Dézippe tous les .mp3 de zip_path, les concatène dans l'ordre alphabétique,
    en insérant 'silence_sec' secondes de silence entre chaque.
    Retourne: {"concat_path": <str>, "total_input_duration": <float>, "file_map": [ {"file":..., "start":..., "end":...}, ... ]}
    """
    out_dir = Path(tempfile.mkdtemp(prefix="whx_zip_"))
    with zipfile.ZipFile(zip_path, 'r') as zf:
        zf.extractall(out_dir)

    # Liste MP3 triés
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

        # silence sauf après le dernier
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

    # Alignement mot-à-mot
    model_a, metadata = whisperx.load_align_model(language_code=result["language"], device=device)
    result_aligned = whisperx.align(
        result["segments"], model_a, metadata, audio_path, device, return_char_alignments=False
    )
    # result_aligned["word_segments"] : [{"word": "Bonjour", "start": 0.42, "end": 0.65}, ...]
    return result_aligned

# =========================
# 2.5) Agréger mots -> segments
# =========================

def words_to_segments(word_segments: List[Dict[str, Any]], max_gap: float = 0.6, max_chars: int = 300) -> List[Dict[str, Any]]:
    """
    Regroupe les mots en segments lorsqu'il y a un trou > max_gap secondes.
    Coupe aussi si le texte devient trop long (> max_chars) pour rester 'prompt-friendly'.
    Retour: [{"i": idx, "start": s, "end": e, "text": "..."}]
    """
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

    # indexer
    for i, s in enumerate(segs):
        s["i"] = i
    return segs

# =========================
# 3) Appel GPT : score des segments par batch
# =========================

def openai_score_segments(segments, model: str, system_prompt: str):
    """
    Envoie un batch de segments à GPT pour scoring.
    Retour attendu JSON: {"scores": [{"i": <int>, "score": <0-5>, "label": "<str optional>"}]}
    """
    payload_segments = [
        {"i": s["i"], "start": round(s["start"], 2), "end": round(s["end"], 2), "text": s["text"][:3000]}
        for s in segments
    ]

    user_prompt = (
        "Tu es un assistant thérapeutique. On te donne une liste de segments (texte + timestamps).\n"
        "Objectif: attribuer un score d'intérêt thérapeutique (0 à 5) à CHAQUE segment.\n"
        "- 0 = sans intérêt; 5 = très pertinent (prise de conscience, émotion, insight, formulation de besoins, schéma répétitif, etc.).\n"
        "Retourne UNIQUEMENT un JSON de la forme: {\"scores\": [{\"i\": int, \"score\": float, \"label\": \"...\"}]}\n"
        "N'invente pas d'indices temporels. Ne renvoie pas le texte.\n\n"
        f"Segments:\n{json.dumps(payload_segments, ensure_ascii=False)}"
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

def score_all_segments_with_gpt(segments: List[Dict[str, Any]], model: str, batch_size: int = 150) -> List[Dict[str, Any]]:
    """
    Score tous les segments par batchs pour éviter les prompts trop volumineux.
    Retourne une liste de dict {"i", "score", "label"}.
    """
    system_prompt = (
        "Tu es un expert en analyse de discours thérapeutique. "
        "Tu évalues l'intérêt clinique de segments parlés pour en faire un best-of audio."
    )
    all_scores = []
    for batch in batched(segments, batch_size):
        scores = openai_score_segments(batch, model=model, system_prompt=system_prompt)
        all_scores.extend(scores)
    # map par i
    score_map = {int(s["i"]): {"score": float(s.get("score", 0.0)), "label": s.get("label", "")} for s in all_scores if "i" in s}
    # fusion dans segments
    out = []
    for s in segments:
        meta = score_map.get(s["i"], {"score": 0.0, "label": ""})
        out.append({**s, **meta})
    return out

# =========================
# 3.5) Sélection jusqu'à la durée cible
# =========================

def select_segments_to_target(scored_segments: List[Dict[str, Any]], target_seconds: float) -> List[Dict[str, Any]]:
    """
    Trie par score descendant, puis ajoute les segments jusqu'à atteindre ~target_seconds.
    On merge les segments trop proches (<0.2 s) pour éviter du hachage excessif.
    """
    # Trier par score desc puis par longueur (longs d'abord)
    ss = sorted(scored_segments, key=lambda s: (s.get("score", 0.0), s["end"] - s["start"]), reverse=True)

    selected = []
    total = 0.0
    for seg in ss:
        dur = seg["end"] - seg["start"]
        if total + dur <= target_seconds * 1.03:  # petite marge 3%
            selected.append({"start": seg["start"], "end": seg["end"], "label": seg.get("label", "")})
            total += dur
        if total >= target_seconds:
            break

    # Merge segments proches
    merged = []
    for seg in sorted(selected, key=lambda x: x["start"]):
        if not merged:
            merged.append(seg)
            continue
        if seg["start"] - merged[-1]["end"] < 0.2:  # gap < 200ms => fusion
            merged[-1]["end"] = max(merged[-1]["end"], seg["end"])
            merged[-1]["label"] = (merged[-1]["label"] + " | " + seg.get("label", "")).strip(" |")
        else:
            merged.append(seg)

    return merged

# =========================
# 4) Construire le best-of audio
# =========================

def build_bestof_audio(concat_mp3_path: str, clips: List[Dict[str, Any]], out_path: str) -> float:
    """
    Extrait chaque clip [start,end] de l'audio concaténé et les assemble.
    Retourne la durée du best-of (sec).
    """
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
# Main pipeline
# =========================

def main():
    parser = argparse.ArgumentParser(description="ZIP -> Concat -> WhisperX -> GPT scoring -> Best-of audio")
    parser.add_argument("zip_path", help="Chemin du ZIP contenant des MP3")
    parser.add_argument("--keep_pct", type=float, default=20.0, help="Pourcentage de durée à garder (ex: 20 pour 20%)")
    parser.add_argument("--silence_between", type=float, default=10.0, help="Silence (s) entre MP3 à la concaténation")
    parser.add_argument("--openai_model", default="gpt-4o-mini", help="Modèle OpenAI pour le scoring des segments")
    parser.add_argument("--out_dir", default="bestof_out", help="Dossier de sortie")
    args = parser.parse_args()

    # Clé OpenAI
    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError("Veuillez définir la variable d'environnement OPENAI_API_KEY.")


    # 1) Unzip + concat
    concat_info = unzip_and_concat(args.zip_path, silence_sec=args.silence_between)
    concat_mp3 = concat_info["concat_path"]
    total_input = concat_info["total_input_duration"]

    print(f"[INFO] Concat terminé: {concat_mp3} ({human_time(total_input)})")

    # 2) WhisperX word-level
    aligned = transcribe_wordlevel_whisperx(concat_mp3)
    words = aligned.get("word_segments", [])
    if not words:
        raise RuntimeError("Aucun word_segment retourné par WhisperX.")

    # 2.5) mots -> segments
    segments = words_to_segments(words, max_gap=0.6, max_chars=300)
    print(f"[INFO] Segments générés: {len(segments)}")

    # 3) Scoring via GPT (par batch)
    print("[INFO] Scoring GPT en cours (par batchs)...")
    scored = score_all_segments_with_gpt(segments, model=args.openai_model, batch_size=150)

    # 3.5) Sélection jusqu'à target
    keep_ratio = max(0.0, min(1.0, args.keep_pct / 100.0))
    target_seconds = total_input * keep_ratio
    chosen = select_segments_to_target(scored, target_seconds=target_seconds)
    print(f"[INFO] Clips sélectionnés: {len(chosen)} pour une cible ~ {human_time(target_seconds)}")

    # 4) Construire best-of
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Sauvegarde JSON des clips
    clips_json_path = str(out_dir / "clips_selected.json")
    with open(clips_json_path, "w", encoding="utf-8") as f:
        json.dump({"clips": chosen, "target_seconds": target_seconds, "input_seconds": total_input}, f, ensure_ascii=False, indent=2)

    bestof_mp3 = str(out_dir / "bestof.mp3")
    best_dur = build_bestof_audio(concat_mp3, chosen, bestof_mp3)

    print("\n=== RÉSULTAT ===")
    print(f"Durée input totale : {human_time(total_input)}")
    print(f"Objectif gardé     : {args.keep_pct:.1f}%  (~ {human_time(target_seconds)})")
    print(f"Best-of produit    : {bestof_mp3}  ({human_time(best_dur)})")
    print(f"Clips JSON         : {clips_json_path}")

if __name__ == "__main__":
    main()
