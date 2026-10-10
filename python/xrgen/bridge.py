#!/usr/bin/env python3
"""xrgen.bridge — JSON-lines RPC over stdio.

Run:  python3 -m xrgen.bridge        (from the python/ directory)
      python3 xrgen/bridge.py        (also works; path is fixed up below)

Protocol: one JSON object per line on stdin, one JSON object per line on
stdout. This is the seam that makes Python easy to run next to C++ and C#:
any language that can spawn a process and read lines can call every op.

Request:  {"op": "heightfield", "params": {"seed": 7, "w": 4, "h": 4,
                                           "features": 6.0, "octaves": 4}}
Response: {"ok": true, "result": [...]}
Error:    {"ok": false, "error": "..."}

Ops: ping, heightfield, latent, style_weights, stylize, biomes.
"""
import json
import os
import sys

try:
    from .ml import MlGenerationProvider
    from .audio import AudioComposer
except ImportError:  # allow running as a plain script: python3 xrgen/bridge.py
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from xrgen.ml import MlGenerationProvider
    from xrgen.audio import AudioComposer

PROVIDER = MlGenerationProvider()
COMPOSER = AudioComposer()


def _handle(req: dict):
    op = req.get("op")
    p = req.get("params", {}) or {}
    if op == "ping":
        return {"language": PROVIDER.language_tag, "ops": ["ping", "heightfield", "latent", "style_weights", "stylize", "biomes", "compose"]}
    if op == "heightfield":
        return PROVIDER.heightfield(p["seed"], p["w"], p["h"], p["features"], p["octaves"])
    if op == "latent":
        return PROVIDER.latent(p["seed"], p["dim"])
    if op == "style_weights":
        return PROVIDER.style_weights(p["style_seed"])
    if op == "stylize":
        return PROVIDER.stylize(p["heights"], p["w"], p["h"], p["style_seed"], p.get("amount", 0.45))
    if op == "biomes":
        return PROVIDER.biomes(p["seed"], p["n"])
    if op == "compose":
        return COMPOSER.compose(p["seed"], p.get("bars", 4), p.get("bpm", 96.0))
    raise ValueError(f"unknown op: {op}")


def main() -> None:
    stdin, stdout = sys.stdin, sys.stdout
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            result = _handle(json.loads(line))
            stdout.write(json.dumps({"ok": True, "result": result}) + "\n")
        except Exception as e:  # never let one bad request kill the bridge
            stdout.write(json.dumps({"ok": False, "error": str(e)}) + "\n")
        stdout.flush()


if __name__ == "__main__":
    main()
