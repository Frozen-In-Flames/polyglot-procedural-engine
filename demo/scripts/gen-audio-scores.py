#!/usr/bin/env python3
"""Generate the Python-composed score consumed by the First Light demo.

Runs the REAL composer (python/xrgen/audio.py) and writes
demo/public/gen/python-score.json in the engine's shared score format.
The demo's ScorePlayer renders it with WebAudio; the C# and Swift/Kotlin
composers write the same format.

Regenerate:  python3 demo/scripts/gen-audio-scores.py   (from repo root)
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "python"))

from xrgen.audio import AudioComposer  # noqa: E402

SEED = 20261010

doc = AudioComposer().compose(SEED)
doc["regenerate"] = "python3 demo/scripts/gen-audio-scores.py"

out_path = os.path.join(ROOT, "demo", "public", "gen", "python-score.json")
os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, "w") as f:
    json.dump(doc, f, indent=1)
print(f"wrote {out_path} ({len(doc['events'])} events, loop {doc['loop_dur']}s)")
