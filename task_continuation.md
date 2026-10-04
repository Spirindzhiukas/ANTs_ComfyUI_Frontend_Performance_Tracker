# Task handover — current state (v2.7.4)

This file supersedes the v2.7.3 handover below it in Git history. It is a current
status summary, not a script to follow blindly: verify the workspace if continuing
later, and keep harness evidence separate from live-page validation.

## User's active acceptance criteria

1. **Establish stand-in performance on the user's CPU-only Electron with Nodes 2.0.**
   The user's estimate is about 15 FPS with stand-ins enabled versus 25 FPS without.
   The supplied telemetry had low-zoom drawing off, so it does not establish that
   difference. A same-page paired test is still required; do not cite the current
   harness suite as an FPS measurement.
2. **Improve and diagnose poor Nodes 2.0 stand-ins.** Legacy thumbnails reportedly
   look correct; Nodes 2.0 pictures were clipped/truncated and repopulated badly
   after switching back. Code-level text regressions now distinguish the three
   routes below, and the renderer-switch/cache path has tests, but neither live
   Electron pixel equality nor the user's disk-folder repopulation check is confirmed.
   Dark control/background differences remain undiagnosed.
3. **Keep stand-ins visible and draw live execution/error state marks over them.**
   The user's report says flicker is already gone: do not reintroduce the old live/
   picture handoff. Progress and error marks now overlay held Vue pictures and are
   not frozen into them. Video and link-drag handling still hands the live element
   back. The separate Vue executing outline is not reconstructed; do not claim it is.
4. **Draw the classic amber/black high-voltage warning badge** on a new stand-in and
   include it in the stored picture.
5. **Add a Vue textarea regression** for line layout/clipping from available box
   lines, not an assumed 2,000-character value cap.

## Work completed in this pass

- `web/tracker.js` is version **2.7.4**. Vue progress/error fields are excluded from
  the bitmap signature and queued captures; `lodSnapPaint` overlays current marks
  after the held picture. State clear removes marks on the next draw without a
  recapture. Canvas-renderer running/erroring nodes remain live as before.
- The amber triangle / dark outline / lightning bolt badge paints on live fallback
  boxes. Captures add it after the capture ink check and before mipmaps/disk; its
  version token invalidates older pictures. The helper explicitly restores changed
  canvas styles so test wrappers cannot leak its black `strokeStyle`.
- Text bounds are intentionally path-specific:
  - ordinary Vue DOM text: 2,000-character per-string cap;
  - Vue textarea/form values: no hard 2,000-character slice; wrapping and clipping
    are bounded by the box's available lines;
  - canvas DOM-widget text composite: 2,000-character slice and 12-line cap.
  Same-length middle edits to ordinary Vue text invalidate the picture.
- Regressions cover held-picture state overlays/no recapture, video/link drag, live
  badge and capture ordering/blank-ink rejection, ordinary Vue text cap, textarea
  line clipping and >2,000-character tail, canvas widget cap, and a middle edit.
- The earlier complete-suite failure (badge `strokeStyle` left as `#111111` in the
  fake context) was fixed with explicit context-property restoration. No temporary
  debug log remains.
- Documentation has been updated in `README.md`, `CHANGELOG.md`, `memory.md`,
  `ANALYSIS.md`, `plan.md`, and `docs/nodes-2.0-contract.md` to distinguish verified
  behavior from unverified Electron performance/pixel claims.

## Verification status at handover

- `node tests/run-tests.mjs`: **246 passed**, exit 0, after the source, UI copy,
  canvas harness, and preview generator changes.
- Targeted regressions for Vue ordinary text, textarea layout/tail, canvas DOM-widget
  text cap, long text/middle edit, state overlay, and badge passed individually.
- `python3 tests/test_init.py`: **9 passed**. `node tests/demo.mjs`: exit 0; its
  rendering-settings copy was checked for the new Nodes 2.0 overlay/live-element
  behavior.
- ES-module syntax checks for `web/tracker.js` and `tools/box-preview.mjs` passed;
  duplicate top-level-function scan was empty; `git diff --check` passed.
- Regenerated `preview/boxes.html` and `preview/boxes.svg`. The preview serializer
  now preserves canvas paths as well as rectangles and shows the warning badge
  (54 path operations across the six fixtures and three detail levels).
- No real CPU-only Electron/browser A/B was available in this workspace. Do not
  interpret the synthetic harness or a report with low-zoom drawing off as proof of
  the 15-versus-25 FPS estimate.

## Remaining user-side evidence

For the performance question, collect two reports from the same Electron page and
same workflow, zoom, display scale, camera action and time window:

1. stand-in threshold active (for example 50% while viewing at 10% zoom); confirm the
   Status/report says Nodes 2.0, picture/boxes active, and `vueBlanked` is nonzero;
2. stand-ins off, with all other settings unchanged.

Compare FPS plus p50/p95/p99/max frame time, stalls/sec and `bound renderFrame` /
forced layout, and the stand-in counters (`vuePaintSkipped`, `vueBoxes`, pictures
served/captured, DOM writes/layout reads). An on/off pair with the threshold off in
both conditions is not a valid result. For appearance, a live-node/stand-in
screenshot pair of the same dark control/background is needed; for the disk claim,
repeat the user's empty-thumbnail-folder renderer-switch test.

## Relevant workspace files

- `web/tracker.js` — implementation; state overlay, warning badge, text caps/signatures.
- `tests/drawing.test.mjs` — renderer and text regressions.
- `tests/harness.mjs` — fake canvas `save/restore` does not restore style properties; it now records `closePath` for the badge geometry.
- `tools/box-preview.mjs` — records rectangles and serializes the badge's real canvas paths into SVG.
- `preview/boxes.html`, `preview/boxes.svg` — regenerated with badge paths visible.
- `README.md`, `CHANGELOG.md`, `memory.md`, `ANALYSIS.md`, `plan.md` — updated docs.
- `docs/nodes-2.0-contract.md` — upstream renderer contract and live-validation limits.
- `preview/boxes.html`, `preview/boxes.svg` — generated real-painter box previews; regenerate after badge changes.

## Branch

This session stays on `arena/01a1089b-ants-comfyui-frontend-performa`. Do not switch
branches. Commit `1e1253c` has been pushed there; draft PR #3 is open at
https://github.com/Spirindzhiukas/ANTs_ComfyUI_Frontend_Performance_Tracker/pull/3.
The PR is not merged. Keep any follow-up commit and push on this same branch.