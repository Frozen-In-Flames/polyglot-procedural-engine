#!/usr/bin/env python3
"""Generate the Python ML style parameters consumed by the First Light demo.

Runs the REAL provider (python/xrgen) — not a stub — and writes the seeded
MLP weights to demo/public/gen/python-style.json. The demo loads them at
runtime and applies the style over the C++-generated terrain heights, so
what you see on screen is Python's math shaping C++'s math.

Regenerate:  python3 demo/scripts/gen-style-params.py   (from repo root)
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "python"))

from xrgen.ml import MlGenerationProvider  # noqa: E402

STYLE_SEED = 20261010

provider = MlGenerationProvider()
doc = {
    "generator": "xrgen.ml.MlGenerationProvider",
    "language": provider.language_tag,
    "style_seed": STYLE_SEED,
    "weights": provider.style_weights(STYLE_SEED),
    "regenerate": "python3 demo/scripts/gen-style-params.py",
}

out_path = os.path.join(ROOT, "demo", "public", "gen", "python-style.json")
os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, "w") as f:
    json.dump(doc, f, indent=1)
print(f"wrote {out_path}")
