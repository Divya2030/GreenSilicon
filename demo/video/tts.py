"""Generate the voice-over for every caption in record.mjs.

Uses Microsoft neural text-to-speech via edge-tts (free; the narration text is
sent to Microsoft's speech service). Writes audio/<hash>.mp3 plus
audio/manifest.json mapping caption text -> clip and duration, which
record.mjs uses to hold each caption exactly as long as it is spoken.

    python tts.py [--voice en-US-AvaNeural] [--rate -2%]
Other native-English female voices: en-US-AriaNeural, en-US-JennyNeural,
en-US-EmmaNeural, en-GB-SoniaNeural.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import subprocess
from pathlib import Path

import edge_tts

HERE = Path(__file__).parent
AUDIO = HERE / "audio"

# Written text -> how it should be spoken
SPOKEN = [
    (r"\bCO2e\b", "C O two equivalent"),
    (r"\bCO2\b", "C O two"),
    (r"(\d+) nm\b", r"\1 nanometer"),
    (r"\bEIP-712\b", "E I P seven-twelve"),
    (r"\bHBM\b", "H B M"),
    (r"\bGHG\b", "G H G"),
    (r"\bI/O\b", "I O"),
    (r"\bQR\b", "Q R"),
    (r"\bIEEE\b", "I triple E"),
    (r"\bAI\b", "A I"),
    (r"\b99\.9\b", "ninety-nine point nine"),
]


def spoken(text: str) -> str:
    for pat, rep in SPOKEN:
        text = re.sub(pat, rep, text)
    return text


def captions() -> list[str]:
    src = (HERE / "record.mjs").read_text()
    return [bytes(m, "utf-8").decode("unicode_escape") for m in re.findall(r'say\("((?:[^"\\]|\\.)*)"', src)]


def duration(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


async def main(voice: str, rate: str) -> None:
    AUDIO.mkdir(exist_ok=True)
    manifest = {}
    for text in captions():
        key = hashlib.sha1(f"{voice}|{rate}|{text}".encode()).hexdigest()[:12]
        path = AUDIO / f"{key}.mp3"
        if not path.exists():
            await edge_tts.Communicate(spoken(text), voice, rate=rate).save(str(path))
        manifest[text] = {"file": f"audio/{path.name}", "duration": duration(path)}
        print(f"{manifest[text]['duration']:5.1f}s  {text[:70]}")
    (AUDIO / "manifest.json").write_text(json.dumps({"voice": voice, "rate": rate, "clips": manifest}, indent=1))
    print(f"{len(manifest)} clips, {sum(c['duration'] for c in manifest.values()):.0f}s of speech, voice {voice}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", default="en-US-AvaNeural")
    ap.add_argument("--rate", default="-2%")
    a = ap.parse_args()
    asyncio.run(main(a.voice, a.rate))
