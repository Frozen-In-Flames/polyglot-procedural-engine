# Deployed FX demo snapshot

These files are the deployed artifacts of the v10 demo page (the Dev
Flexibility / FX demo), copied byte for byte from the live site on
2026-10-20:

- Source: https://frozen-in-flames.github.io/polyglot-procedural-engine/v10.html
- `v10.html` (the page as served)
- `assets/v10-BPYoN9o8.js` (the page's JS bundle)
- `assets/semantic-DrEJTg_R.js` (the shared chunk the bundle imports)

Why this snapshot exists: the FX panel in the deployed bundle was built
from TypeScript sources that were never committed to main. A rebuild from
main therefore cannot reproduce the deployed page, and regenerating the
demo from sources alone could silently lose the panel. This snapshot is
the preserved record of what is actually deployed, kept in the repo so
the panel survives independent of the build.

Rules:

- Treat these files as read-only artifacts. Do not edit them to fix
  engine bugs.
- Engine fixes belong in the engine sources (`src/`) and the demo
  sources, with tests. If the demo is ever rebuilt and redeployed,
  refresh this snapshot from the new live artifacts and update the
  filenames and date above.
