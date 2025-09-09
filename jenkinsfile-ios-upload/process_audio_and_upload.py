import sys
import subprocess
import base64
import json
import requests
from pathlib import Path
from datetime import datetime

# === CONFIGURATION ===
GAS_UPLOAD_ENDPOINT = "https://script.google.com/macros/s/AKfycbxbC1UxH75oMuEdrd-mmOa3jr31cjphyWJFwbr0wWvQQ4e-pTu9mHXPmJWLqVuRxXsSzg/exec"
HUMAN_DATE = datetime.utcnow().strftime('%Y-%m-%d')

# === INPUT ===
input_path = Path(sys.argv[1])
assert input_path.exists(), f"File not found: {input_path}"

# === Convert to MP3 ===
output_path = input_path.with_name(f"recording_{HUMAN_DATE}.mp3")
subprocess.run([
    "ffmpeg", "-y", "-i", str(input_path),
    "-codec:a", "libmp3lame", "-qscale:a", "2",
    str(output_path)
], check=True)

print(f"✅ Converted to: {output_path.name}")

# === Encode to base64 ===
b64_data = base64.b64encode(output_path.read_bytes()).decode("utf-8")
payload = {
    "filename": output_path.name,
    "mimeType": "audio/mpeg",
    "data": b64_data
}

# === Send to GAS ===
response = requests.post(
    GAS_UPLOAD_ENDPOINT,
    headers={"Content-Type": "application/json"},
    data=json.dumps(payload)
)

# === Handle response ===
try:
    result = response.json()
    print(f"✅ Upload success. URL: {result.get('url')}")
except Exception:
    print(f"⚠️ Upload response: {response.text}")
