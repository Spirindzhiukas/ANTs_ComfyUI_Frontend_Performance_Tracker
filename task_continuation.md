# task_continuation.md — where the next session starts

**Status: not done. The user is still waiting.**

This file exists so the next session does not have to re-derive the state from a
condensed history. `memory.md` is the past, `plan.md` is the roadmap, `/home/user/docs/`
(created 2026-10-04) holds the long-form reference material. This file is the
**handover**: what is proven, what is not, and what to do first.

Written at **v2.7.3** (`7f6aba5`), merged into `main` by PR #2. Suite **240
passed**, `tests/test_init.py` 9 OK, `demo.mjs` exit 0 — those are green and stay
green; they are not what is missing.

---

## 1. What the user is still waiting for (the acceptance criteria that are NOT met)

The user's own words, in the order they matter:

1. **"Performance hit is the same" — with stand-ins on, in Nodes 2.0, on the
   user's CPU-only Electron.** The last numbers reported (report 13, v2.7.1): 75
   nodes / 95 links, zoom 0.10, 3840×2020 dpr2 — fps **20**, mean 24.5 ms, p50
   2.30 ms, **p99 221.3 ms, max 295.4 ms**, **1088 stalls / 124 ms per second**,
   **`bound renderFrame` 743 calls / 55 587 ms**, forced layout 4298 ms. For
   comparison, v2.6.7 on the same page: fps 73 / mean 4.74 ms. The v2.7.2 floor and
   the v2.7.3 theme fix reduce *this tool's* work; **the user has not yet confirmed
   any of it on their machine, and the biggest line in their report is the
   frontend's own render path, not the capture lane.**
2. **The picture must look like the node the user sees.** "Still not there yet",
   "semi not fully there", "captured too early", "node colours become different",
   text cut mid-word in the wrong font, muted nodes at full strength, a real node's
   body as a flat empty panel with its widget controls missing. v2.6.7–v2.7.1 fixed
   a long list of these; the next report has to say whether **any** remain.
3. **"Maybe we need to rethink our node photograph capturing process for nodes 2.0
   — take simple screenshots of the nodes as a completed thing as it is being shown
   by the frontend to the human user in the ui itself."** Sanctioned route, not yet
   taken: the raster route (`plan.md` **K10**) — clone the node, inline computed
   styles, embed fonts, `<svg><foreignObject>` → `Image` → `drawImage`. Not
   shipped because it cannot be A/B'd from this sandbox (no browser obtainable), and
   because its refusals must be carried with it (see `docs/node-snapshots.md`).
4. **A stand-in must show the node's state the way the page does** — the executing
   ring, the progress bar, the error stroke — **without freezing them into the
   picture.** Today's design hands the element back to the frontend while a node is
   running/erroring/dragged, so the picture never carries state at all. That
   satisfies "never a lie" but not yet "shows the state"; whether the user wants the
   marks drawn over a standing-in picture is an **open question to ask**, not to
   assume.
5. **The user's own disk test:** empty
   `c:\ComfyUI_PORTABLE\ComfyUI\temp\ANTs_Frontend_Optimizer_THUMBNAILS\`, switch
   renderers, watch it repopulate. Built (v2.6.3–2.6.4, renderer token in the key);
   **never confirmed by the user.**
6. **Do not let legacy success pollute the Nodes 2.0 design.** No draw-call
   interception, no `arrange()`-seeded geometry in the Vue pathway. Keep the two
   pathways sharing the settings values only.

## 2. What is proven (do not re-litigate these)

| Area | State | Evidence |
| --- | --- | --- |
| Capture rate floor | 600 ms between pictures of one node; 5 s between its disk files; a postponed node **stays queued** | v2.7.2; tests `"photographed at a floor"`, `"its own grace period"`, `"writes its file at a floor"`; `/tmp/mut-m{1..4}-*.js` |
| Theme signature | the **resolved colours** are the signature; class names are only the doorbell; 2 s re-sample from the frame hook | v2.7.3; `/tmp/probe/theme.mjs` (class 120→0 captures, colour 0→120); test `"not a theme change"` |
| Steady-state cost | 0 rects / 0 `querySelectorAll` / 0 `getComputedStyle` / 1 attribute read per node per frame; every steady-state rect is a *pictured* node's re-measure after a page report, captures Δ0 | `/tmp/instr-rects.mjs` + `churn-meas.mjs`; `docs/performance-model.md` §C |
| Picture contents | chrome, header colour, wrapped text in its own font, widget rows as real controls, icons as SVG mask paths, badge pills, footer band, blitted media, muted opacity, translated `rgba()` colours | v2.6.8–v2.7.1; the picture-content tests; the fidelity inventory rig |
| Element lifecycle | identity by `data-node-id`, hand-back rules, 500 ms orphan window, additions-first reports | v2.7.0; the element-lifecycle tests |
| Disk | both renderers write the same folder; the renderer token (`pv`/`pc`) is in the key; resolution changes take effect both ways; sub-1 ratios real | v2.6.3–2.6.4; the disk suite |
| No zoom LOD in the frontend | verified against sources and by `lodVueLodProbe` | v2.6.8, `docs/renderer-contract.md` §1 |
| State is never frozen | a running/erroring/dragged node keeps its own element | v2.6.9; `lodSnapLive` |

## 3. The open threads, with their references

1. **K12 — the `renderFrame` regression (v2.6.7 → v2.7.1).** 85 % of the frame
   budget is outside drawing; the largest line is the frontend's own
   `bound renderFrame` (743 calls / 55 587 ms in report 13). This tool wraps
   `renderFrame`; the first question is whether a stand-in's *presence* (a subtree
   kept in layout under `visibility: hidden`) makes the frontend's measure/resize
   passes pay more. The recorded next experiment is the **`display: none` vs
   `visibility: hidden` A/B** for stand-in bodies — `display: none` removes the
   layout the frontend's own passes currently read, which is why it was not done
   blindly. Do it on the user's page with the stall counters visible.
2. **Per-setting savings are not measured.** The panel's abortable A/B covers
   links, not node drawing. The user's rule is "measured, not explained away".
3. **The colour reader's blind spot.** `lab()`, `lch()`, `color(display-p3 …)` are
   unparsed; such a surface is dropped and counted (`vueColorSample`) — never
   guessed. Any widening must keep the hole-and-count test.
4. **Unbound code paths:** `lodSnapCaptureNode`'s 600 ms re-check and the
   `cached: true` wait path (reachable only through `lodVueForceCapture`) have no
   test that fails when they are removed. Bind them or record them again.
5. **K10 (raster picture route) and K13 (`content-visibility: auto` on node
   bodies).** Both written down with their prices in `plan.md`; K13's price is
   body-size churn re-making pictures plus a subtree the reader cannot measure.
6. **A pack's canvas-drawn widget content** is invisible (no element to walk) and
   pack HTML stays blank and counted — a limit of the page, recorded in K11.

## 4. First steps for the next session, in order

1. **Get a fresh report from the user on v2.7.3.** The tool's own copy-report
   button carries exactly the numbers needed: fps / p50 / p99 / max, stalls in
   `bound renderFrame`, forced layout, pictures served vs captured, the stand-in
   counters. Ask for it before writing any code — the last three passes were each
   sent by a report, and the two fixes already in the branch are unconfirmed.
   Also ask two yes/no questions: does the THUMBNAILS folder repopulate on a
   renderer switch, and does the flicker between a live node and its stand-in
   still happen?
2. **Attribute the `renderFrame` stalls** (§3.1): `display: none` vs
   `visibility: hidden` for stand-in bodies, on the user's page, with the stall
   counters. If the frontend stops re-measuring 75 subtrees, that is report 13's
   largest line.
3. **If any picture still looks wrong**, ask for one node type and one pair of
   screenshots (the live node and its stand-in). Then name what the reader missed
   from the readout's own counters (`vueColorSample`, `vueIconSkip`, the blank
   counters, the wait reasons) instead of guessing — every previous fidelity
   defect was named this way.
4. **Ask the state question (§1.4)** before building anything: should a
   standing-in picture draw the executing ring / progress bar / error stroke over
   itself (live, from `node.progress` / `node.has_errors`), or is handing the live
   element back the right behaviour?
5. **Then choose between K10 and K13** with the numbers from (2) in hand. K10 is
   the sanctioned "simple screenshots" route; K13 is the cheaper lever that shifts
   work onto the browser.

## 5. How to work in this checkout

```bash
cd /home/user/ANTs_ComfyUI_Frontend_Performance_Tracker
git fetch origin 'refs/heads/*:refs/remotes/origin/*'
node tests/run-tests.mjs                  # 240 passing, zero deps
node tests/run-tests.mjs "the Nodes 2.0"  # a filter must match a test name
python3 tests/test_init.py                # 9 OK
node tests/demo.mjs                       # exit 0
```

- **A fresh sandbox is re-cloned** at the base commit with the working tree
  overlaid from the snapshot: HEAD reads `4c13726` and `git status` shows the whole
  body of work as uncommitted. Recover with `git fetch …` + `git reset --mixed
  origin/arena/01a10215-ants-comfyui-frontend-performa` (this restores `HEAD` to the
  branch tip while keeping the tree — the tree is identical to the tip, so the diff
  after the reset is empty). **Never `git reset --hard` on a dirty tree.**
- The session branch is `arena/01a10215-ants-comfyui-frontend-performa`; work stays
  on it and PRs come from it. PR #2 (v2.5.4 → v2.7.3) was merged into `main` with
  this file.
- Probes live in `/tmp/probe/` (note: `/tmp` is **not** persisted between turns —
  if it is empty, rebuild from `docs/performance-model.md` §"instruments" and this
  file's references). The instrumented tracker is `/tmp/instr-rects.mjs`.
- `ANTS_TRACKER=/path/to/copy.js node tests/run-tests.mjs "<filter>"` runs the suite
  against a copy — how a test is proven to fail pre-fix and how a mutant is caught.
- No browser can be obtained in this sandbox (puppeteer / chrome-for-testing
  ECONNRESET; apt mirrors unreachable). Nothing about how a picture *looks* can be
  settled here — only what the reader read. Say so rather than claiming otherwise.
- Release bookkeeping and the domain checklists are in `/home/user/docs/`
  (`checklists.md`, `README.md`, `performance-model.md`, `renderer-contract.md`,
  `node-snapshots-findings.md`); the repo's own `docs/` holds the NodeSnapshots
  reading, the capture-rate attribution and the renderer contract.
- `gh pr edit` is broken here: patch with `gh api --method PATCH … -f title='…'`
  and **`-F body=@file`** (`-f body=@file` sends the literal string).

## 6. The one-sentence summary

The last two releases made this tool's own capture lane measurably cheap and
stopped it from re-photographing nodes for the wrong reasons; **neither is the
finish line — the user's page still shows 20 fps with 124 ms of stalls per second,
and the pictures are still not confirmed to be the node the user sees.**
