"""xrgen — Python ML/procedural generation provider for the xr-engine.

Pure functions of (seed, params). Standard library only, so this runs
anywhere CPython runs: embedded next to C++ via the C API, spawned as a
subprocess from C# or TypeScript, or imported directly.

The two integration paths:
  1. ``python -m xrgen.bridge`` — JSON-lines RPC over stdio. Any language
     that can spawn a process and read lines can call every op.
  2. ``from xrgen.ml import MlGenerationProvider`` — direct import for
     Python hosts and build-time tooling.
"""
from .ml import MlGenerationProvider

__all__ = ["MlGenerationProvider"]
