# What works, what fails, and what was taken out

An audit of the repository as of v2.5.4, done by reading the sources rather
than the docs, running the suites, and running the demo. Every claim below
has a file and (where it matters) a line reference. Found defects were fixed
in the same pass; retired ideas were removed rather than documented as if
they still existed.

## How this was checked

```bash
node tests/run-tests.mjs        # 172 passing (171 before this pass; one added)
python3 tests/test_init.py      # Ran 9 tests ... OK
node tests/demo.mjs             # exit 0, prints every tab
cp web/tracker.js /tmp/x.mjs && node --check /tmp/x.mjs   # ES-module syntax
grep -n "^function " web/tracker.js | sed 's/.*function //;s/(.*//' | sort | uniq -d   # no duplicates
```

Ground truth was, in order: `web/tracker.js` (~12k lines, the whole
frontend), `__init__.py` (the node and the nine routes), `web/window.html`
(the separate page), the test suite, and `node tests/demo.mjs` output. The
README was treated as a suspect, not a spec — it described v2.1.

## What works

### Backend (`__init__.py`)

- The node is a no-op: `CATEGORY = "ANTs"`, no inputs, no outputs, no
  execution; it exists only to carry the canvas pill (`__init__.py:522-539`).
  Graphs saved under the old class key still load — the alias and both
  mappings are asserted in `tests/test_init.py:34-37`.
- Nine routes are registered best-effort (`__init__.py:456-504`), so a
  ComfyUI version that already has one of them does not break the import:
  the GPU probe, five thumbnail routes, the window page and the two halves of
  the `/ants_optimizer/ui` link. The UI link is memory only — a revision, an
  origin, the settings and the last report — and a malformed POST is a 400,
  not an exception.
- The thumbnail store is guarded where it touches disk: a 7-day age sweep,
  an 8 MB per-file cap, a directory under ComfyUI's temp, and a fallback
  that simply serves no pictures when the folder cannot be found. The
  `tests/test_init.py` suite exercises the path handling, the read/write and
  the sweep against a temporary directory.

### Frontend measurement

- `app.registerExtension` is wrapped before any other extension loads
  (`web/tracker.js`, `patchRegisterExtension`), so every later extension's
  `beforeRegisterNodeDef` is instrumented by name. Hooks that would otherwise
  be invisible — pre-existing prototypes and per-instance
  `this.onDrawForeground = …` — are adopted while drawing and attributed.
- Costs are normalised per drawn frame, with hook time outside `canvas.draw()`
  kept in a separate off-frame column; the redraw-request rate comes from a
  wrapped `setDirty()` with callers from sampled stacks; stalls come from
  Long Animation Frames with a `longtask` fallback.
- The scheduler layer wraps the page's own timer/rAF functions, leaves
  `normal` as a strict no-op (same ids, so `clearInterval` still works),
  slows rather than silences, and exempts the tracker's own timers.
- The window/page link is symmetric: the window applies settings only when
  the revision changed and the origin is not `"window"`; the page applies
  only when the origin is `"window"`, runs a command when `commandRev`
  changes and the origin is not `"page"`, and does not publish while a change
  is being applied (`antsUiApplyRemote`, `antsUiApplySettings`,
  `antsUiPublishSettings`).
- The stand-in engine counts every outcome it can name (served, missing,
  refused for budget, too big, blank, too slow, churned, coarser than the
  ratio, kept live) and the reason is printed in the panel, not just kept
  internally.
- All of the above is covered by the suite, including the separate window
  (opened centred, focused on a second open, panel as the popup-blocked
  fallback), the echo rules, the DOM hiding and restoration, and the claim
  that no second copy of an image preview is ever asked for
  (`tests/drawing.test.mjs:342`).

## What was broken, and what was done about it

| # | Defect | Evidence | Fix |
| --- | --- | --- | --- |
| 1 | **The keep-live list had no door.** The snapshot engine has honoured `snapExclude` since v2.4.0 and the readout says "kept live by your list (T)", but there was no control anywhere in the UI: the only way to add a type was the console. | `snapExclude` was reachable only through `lowZoom.set` / the API. | A text field on both surfaces — panel ("Keep these node types live") and window (`id="keep"`) — normalising the list and counting the types it removes as kept-live-on-purpose. Test: *"the keep-live list is a control, not an API-only setting"*. |
| 2 | **Adding a type to the list did nothing until that node changed.** A node whose picture had already been captured kept being served it: `lodSnapEnqueue` skips records that exist and are not blocked. | Reproduced in the new test: `captured` stayed put and the picture was still drawn. | `lodSet` now drops the records of **newly added** types (`lodSnapDrop(node, "kept live by your list (T)")`), so the effect is immediate and only the added type is re-evaluated. |
| 3 | **The demo mislabelled and skipped tabs.** `TABS` omitted `status`, so every heading from `TIMING` on named the wrong tab, and the Tweaks tab was printed as "TWEAKS TAB" after the panel renamed it "Node Rendering Settings". | `tests/demo.mjs` clicked `tabBar.children[i]` by index against a shorter list. | The list is complete, the label is read from the panel's own button, and the badge is not printed as part of the name. |
| 4 | **The demo explained a feature that no longer exists** — a paragraph about the retired image-preview thumbnail ladder (64px at 10 % zoom, 512px around 60 %), printed after every run. | `tests/demo.mjs:719-721` before the fix. | Replaced with what the stand-in actually is: below the zoom you pick, a captured picture is drawn as one `drawImage`, captured once while the page is idle. |
| 5 | **A source comment claimed behaviour the code does not have:** the file header said links are painted straight "while the graph is rectangles". That coupling was removed in v2.2 — `lodLinksStraight()` looks only at `linkStyle`. | `web/tracker.js` header vs `lodLinksStraight`. | The header now says a link's shape is the user's own choice. Two more stale comments ("thumbnail", "the preview ladder needs") were corrected. |
| 6 | **The README described v2.1**: five tabs (there are ten), a folder that no longer exists, one backend route (there are nine), "nothing else is written server-side", 161 tests, a tab name retired two releases ago, and no credits at all. | Compare README body with the code and `CHANGELOG.md`. | Rewritten from the code: install, use, ten tabs, every setting with its real ladder and default, the window link, the routes, the tests, and a Credits section. The version history moved to `CHANGELOG.md` so the README stops being 900 lines of archaeology. |
| 7 | **No licence and no third-party notices.** The project embeds an idea that comes with an MIT notice, and carried no `LICENSE` of its own. | No `LICENSE`, no notices file (plan.md, Track M). | Added `LICENSE` (MIT), `THIRD_PARTY_NOTICES.md` with the upstream MIT notice verbatim, and the README credits saying exactly what was taken and what was not. |
| 8 | **The window and the page could disagree about a setting with nothing to catch it** — a control that posts a key the page ignores is a control that silently does nothing. | No test compared the two key sets. | New test *"the window and the page agree on which settings exist"*: every key the window posts must be published by the page, and every published key must have a field the window paints. |

## Retired: things that could not work, and were taken out

- **The image-preview thumbnail ladder (v2.1.5).** It kept a second,
  downscaled copy of an image that is *already* a bitmap, per redraw, with
  its own cache, its own storage and its own zoom. The node stand-in
  superseded it in v2.5.0 because the picture of the node is the thumbnail:
  one mechanism instead of two, and no hidden second copy of the picture the
  user is looking at. The implementation was removed; what stays is the
  tombstone (`LOD.thumbZoom = 0`, `lowZoom.previews` →
  `{on:false, retired:true}`) so a saved record or an old script gets an
  answer instead of `undefined`, and three tests pin the fact that it cannot
  be switched back on (`tests/drawing.test.mjs:97`, `326-343`, `1397-1417`).
- **`linkStyle: "auto"`.** A link changed shape because a *node* setting
  crossed a threshold — the exact coupling that the three drawing settings
  are supposed to not have. A saved `"auto"` becomes `"spline"` with a note.
- **"Nodes under Npx".** A per-node pixel rule flips a node in and out of the
  stand-in while its own UI changes size under the pointer. It was replaced
  by a zoom, and a saved pixel value is translated once and shown as what it
  became.
- **Borrowing ComfyUI's frame-level low-quality flag.** It changed what the
  frontend painted (shadows, outlines) rather than only what this tool
  paints, so it could not be scoped to "a link's ink" or "a node's stand-in".
- **The `drawImage` monkey-patch.** It wrapped every blit on the page,
  including other extensions' own blits, which it could not attribute to
  anything — so its time was both double-counted and mislabelled. The node
  stand-in wraps the *node draw* instead, and nothing here patches
  `drawImage`. Related non-promises are stated as limits rather than built:
  a capture cannot leave the main thread (a worker cannot call `drawNode`),
  and the worker lane is kept for pure compute only, saying so when it falls
  back.
- **Dead helpers and constants** removed in the same pass: the unreachable
  boxify/previews toggles, the RAM-reload helper, `LOD.inNode`, the retired
  `img*`/`thumb*` state fields, `LOD_THUMB_*`, `VIEW_INERT_DEFAULT`,
  `SELF_SAMPLE_MS`, `MAX_LOAF_SAMPLES`. (`LOD.thumbZoom` is deliberately kept:
  it is the tombstone above, and tests read it.)

## Limits that are not bugs

The canonical list is the LIMITS block at the bottom of `web/tracker.js` and
is summarised in the README's "What this cannot catch": unnamed widget/Vue
draws, sampled redraw callers (~20/s), no GPU or per-extension VRAM from
page JavaScript, no memory/long-task APIs on Firefox, the scheduler's
inability to reach microtasks or browser-internal work, and the ≤100 ms
staleness of a snapshot signature. These are stated in the UI where they
apply, not just in the docs.

## Features that are honest but smaller than they look

- **The off-thread lane** (`Load` tab) is a working worker with a fallback and
  a deterministic self-test, but its only shipped job is that self-test plus
  the `__antsTracker.worker.offload` API — nothing the page does is actually
  moved off the main thread yet. That is deliberate and stated in the panel
  and the LIMITS block (Vue's render, the DOM and canvas drawing cannot leave
  the main thread; `plan.md`, Track G2, is where real work — aggregation —
  would go). It is not a false claim, but a reader should not expect a speed-up
  from it today.
- **The GPU tab's torch figures** come from ComfyUI's `/system_stats`, not from
  this tool; the per-extension attribution question it cannot answer is stated
  in the tab rather than approximated.

## Still open

- **Firefox and Safari behaviour** is design-verified, not run-verified here:
  the code paths that read `performance.memory` and long tasks are guarded
  and the panel prints "not available" instead of a number, but no browser
  other than the Node harness was executed in this pass.
- **The console-attribution mode** (plan.md, Track L) is still unbuilt. The
  credit for the idea stands; the honest thing is that nothing in the shipped
  code depends on it.
- **Upstream differences** are deliberate and documented: this tool waits
  60 ms before it declares a capture too slow (upstream cuts at 32 ms), and
  it refuses a node by measurement ("whatever the canvas draws") rather than
  by an upstream list of node types.
