# Task handover — current state (v2.7.5)

This is a status summary, not a script to follow blindly. Verify the workspace and
separate harness evidence from live-browser validation.

## User's active acceptance criteria

1. **Warning badge placement:** draw the amber/black high-voltage badge only on a
   live fallback box. Never include it in, or draw it over, a successfully captured
   or cached picture. The signature token changed so old badge-bearing RAM/disk
   entries miss and are rebuilt.
2. **Nodes 2.0 visuals:** investigate the reported clipped/odd CLIP Text Encode
   prompt and other UI appearing in stand-ins. The screenshot's apparent truncation
   despite remaining space is not explained yet. Do not claim these reconstructed
   canvas drawings are browser screenshots.
3. **Metrics row stability:** Timing and per-node-type rows use a 4-second rolling
   window and naturally age out when there is no activity in that window. Stalls
   headline rates use 4 seconds too, while source rows remain visible for up to
   30 seconds after their last event and their source counters accumulate. UI notes
   now communicate those windows. No retention behavior was changed. A Stalls row
   disappearing before 30 seconds, or any row clearing while new samples continue,
   is not explained by the intended window and needs before/after reports.
4. **Governor visibility/state:** the in-page panel always registers Governor in
   both frontend renderer modes. The separate-window page intentionally has five
   tabs and omits Governor. Clean defaults are normal source policies, rAF governor
   off, redraw coalescing off and autopilot off; policies and controls can persist
   in `ants-governor-v1`. The active browser's installed version, chosen panel
   surface and persisted state have not been inspected.
5. **Keep the no-flicker behavior:** the user confirms there is no more flicker.
   Progress/error marks remain live overlays on held Vue pictures; video/link-drag
   still hand the live element back.
6. **Preserve pathway-specific text rules:** ordinary Vue DOM text has its own
   2,000-character prefix limit; Vue textarea/form values are not hard-sliced at
   2,000 and are wrapped/clipped by available box lines; the separate canvas
   DOM-widget composite retains its 2,000-character and 12-line limits.
7. **Still unverified:** CPU-only Electron A/B, live pixel comparison, and the
   user's renderer-switch disk-cache repopulation check. Do not present harness
   correctness as any of those results.

## Work completed in v2.7.5 follow-up

- `web/tracker.js` is version **2.7.5**. The live flat-box painter keeps the badge;
  capture no longer paints it, and cached reuse does not add it as an overlay.
  `LOD_SNAP_BADGE_VERSION` changed to `hv-warning-fallback-only-2`, invalidating old
  badge-bearing picture signatures.
- Badge regression distinguishes the live fallback, the successful offscreen
  capture and the later cached blit; a blank capture is still rejected.
- Timing context, Nodes note and Stalls note disclose the rolling/retained windows.
  Added a core regression showing the Stalls rate reaches zero after 4 seconds
  without a new event while its row is still present at 5 seconds. Retention itself
  is unchanged.
- Panel regression verifies the in-page Governor tab is present, exposes clean
  defaults (no limited source, rAF off, coalescing off, autopilot off), and checks
  the window omissions are separate from panel behavior.
- `README.md`, `CHANGELOG.md`, `memory.md`, `ANALYSIS.md`, this handover, and the
  real-painter preview captions were updated. `preview/boxes.html` and `.svg` were
  regenerated; the badge remains visible there because that fixture runs the live
  fallback box painter.

## Verification

- `node tests/run-tests.mjs`: **247 passed**.
- `python3 tests/test_init.py`: **9 passed**.
- `node tests/demo.mjs`: exit 0.
- `node --check --input-type=module < web/tracker.js`,
  `node --check tools/box-preview.mjs`, preview regeneration and `git diff --check`
  passed.
- No real Electron/browser A/B, live pixel comparison or user's cache-folder test
  has been performed in this workspace.

## Live evidence needed next

On the **ComfyUI page** (not the separate window), run in DevTools:

```js
window.__antsTracker.open();
({
  version: window.__antsTracker.version,
  tabs: [...document.querySelectorAll("#ants-tracker-tabs button")].map(b => b.textContent),
  governor: {
    metrics: window.__antsTracker.governor.metrics,
    controls: window.__antsTracker.governor.state.controls,
    savedPolicies: window.__antsTracker.governor.state.savedPolicies
  }
})
```

That distinguishes an old/unloaded tracker or the five-tab detached window from
an in-page UI visibility bug, and shows whether saved limits are active. Do not
call `governor.reset()` before seeing the state; it changes persistent settings.

For the metrics issue, collect `copy(window.__antsTracker.report)` once while the
rows are populated and again after they disappear. The report has a timestamp,
version, sampling window and per-tab metrics. If the Stalls source row disappears,
record elapsed time since its last event and whether new stalls continued. If a
row clears while samples keep coming, say which tab and whether the page was
paused/reset or reloaded.

For the Nodes 2.0 issue, send a same-node live-vs-stand-in image pair and the
snapshot report without exposing private prompt contents. The relevant diagnostic
surface is `window.__antsTracker.lowZoom.snapshots` (renderer pathway, held/drawn/
captured counters, text/widget counters and refusal reasons); do not dump the full
internal `lowZoom.state.vueMedia`, which can contain raw form values.

## Branch / PR

The v2.7.5 follow-up is committed and pushed to
`arena/01a1089b-ants-comfyui-frontend-performa`; draft PR #3 remains open against
`main`:
https://github.com/Spirindzhiukas/ANTs_ComfyUI_Frontend_Performance_Tracker/pull/3.
The PR is unmerged.
