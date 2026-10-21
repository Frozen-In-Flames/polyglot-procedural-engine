# Ship gate: release verification control

No release and no demo is reported done until every step below passes.
This gate exists because of a measured escape, not as ceremony.

## The escape (Oct 20, 2026)

The v2.0.0 live demo was reported working on the strength of HTTP 200
responses, grep checks on the served files, and a Node smoke test, while
its raymarch fragment shader failed compilation in every real browser.
Two GLSL ES 3.00 defect classes caused it: the parameterized SDF
uniforms were declared twice in the assembled shader, and numeric
options were emitted as raw integer literals in float expressions
(`t > 100`). The compile failure threw during module evaluation, so the
demo panel never initialized and the march loop never started: blank
panel, telemetry at zero, the Regenerate button dead. Node has no GL
context, so no Node-level check could see any of it. The defect was
found by the owner, on his phone, after the success report. False
confidence costs proof of function and reputation; this gate is the
control that keeps the class from recurring.

## The gate

1. **Unit suite green.** The full suite runs on the release commit and
   every test passes. The count is reported with the release.
2. **GLSL contract tests.** The suite includes the contract tests in
   `test/glsl-contract.test.ts`: each parameterized uniform declared
   exactly once in the assembled fragment, no float compared against or
   initialized from a raw integer literal, baked SDF values emitted as
   float literals. Each checker carries a negative control (planted
   defects it must catch) and a specificity control (legal integer GLSL
   it must not flag), so a green run means the checks can actually
   fail.
3. **Real-browser playthrough.** The demo page is opened in a real
   browser engine (a headless browser is fine), at desktop and phone viewport
   sizes. A screenshot is inspected, not just captured. Every control
   on the page is clicked or dragged: panel toggles, Regenerate,
   sliders, policy switches, the touch joystick area. Telemetry must
   read live, nonzero values while the scene renders. A page that
   renders blank, a control that does nothing, or telemetry stuck at
   zero is a failed gate, whatever the unit suite says.
4. **Report only what was verified.** The release report states the
   test count, what the playthrough exercised, and any honest limits.
   Code-level checks (HTTP status, grep, Node runs) are supporting
   evidence, never the verification itself for anything a user touches.

Steps 1 and 2 are automated. Step 3 is a human-discipline step executed
through the browser tooling; skipping it is what caused the Oct 20
escape, so it is not optional for releases that touch the demo or the
renderers.
