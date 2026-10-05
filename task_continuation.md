# Task handover — current state (v2.7.6)

Status summary, not a script to follow blindly. Keep harness evidence separate
from behavior in the user's custom-built Electron shell. The user has no browser
console; do not suggest console commands or blame browser compatibility.

## Active acceptance criteria

1. **Detached-only UI:** the detached optimizer window is the only settings and
   metrics UI. The in-page workflow node stays headless except for its compact
   power switch and gear control; the floating pill remains the control if the
   frontend cannot host the node's DOM widget. The gear opens/focuses the detached
   route. If the shell blocks that launch, show a visible failure and never fall
   back to an in-page panel.
2. **Master-off:** suspend optimizer effects and sampling, including detached GPU
   polling and temporary tests, while preserving appropriate settings for
   re-enable. Governor offload and self-test entry points must not start worker
   work while disabled. A self-test already underway must not publish success if
   master-off occurs before its result is accepted.
3. **Custom Electron shell:** prefer telemetry inside this optimizer/node. Keep
   shell changes separate; if one becomes unavoidable, prepare a request for the
   user's Claude Sonnet 5.5 shell agent. Do not ask for browser-console output.
4. **Warning badge:** intended only for live fallback boxes, never baked into or
   painted over captured/cached pictures. The harness regression is not evidence
   that this is fixed in Nodes 2.0: the user reports the issue persists there in
   their custom Electron shell. Do not call the whole badge issue resolved.
5. **Timing:** the user reports Timing is empty after active panning/zooming.
   Metric-window notes/tests are not evidence of live Timing rows; keep this
   symptom unresolved unless live shell evidence demonstrates otherwise.
6. **No flicker:** the user confirms it is gone; preserve the existing behavior.
7. **Path-specific text:** ordinary Vue DOM text has a 2,000-character prefix
   limit, but Vue textarea/form values are not hard-sliced at 2,000 and wrap/clip
   to available lines. The separate canvas DOM-widget route has 2,000-character
   and 12-line caps. Do not conflate those paths.

## Work completed in v2.7.6

- The detached window owns Node Rendering Settings, Status, Timing, Nodes, Stalls,
  Governor, Load, Memory, GPU/VRAM and Testing. In-page panel construction and its
  fallback were removed from the active UI flow. A blocked open is surfaced rather
  than replaced by an in-page panel.
- The compact workflow-node widget has no text-button fallback; if DOM widgets
  cannot be hosted, the node remains headless and the floating pill remains.
- Master-off suspends optimizer sampling/effects and detached GPU polling. Governor
  worker offload/self-test refuse new work while disabled; a completed worker
  result is rejected if the master switch was turned off while it was in flight.
- The detached Status surface carries renderer, box/snapshot, link-thinning and
  connection-stage, widget/fovea, Vue icon and migration diagnostics. Bridge
  command payloads are discarded except for normalized benchmark inputs.
- README and changelog wording now records the Nodes 2.0 badge and live Timing
  reports as unresolved rather than treating harness tests as proof.

## Verification

- `node --check web/tracker.js`: passed.
- `node tests/run-tests.mjs`: **229 passed**.
- `python -m unittest discover -s tests -p 'test_*.py'`: **9 passed**.
- `git diff --check`: passed.
- No live custom-Electron pixel comparison or live Timing-row validation was
  performed. Tests do not resolve the user's reported badge or Timing symptoms.

## Remaining live evidence

No browser-console procedure is suitable for the user's shell. Use the detached
Status/report surface and visible output where available. If more instrumentation
requires changing Electron itself, keep it in a separate handoff to the user's
Claude Sonnet 5.5 shell agent. A Nodes 2.0 badge fix or Timing diagnosis should
not be claimed until the reported shell behavior is checked; do not expose raw
prompt contents in telemetry.
