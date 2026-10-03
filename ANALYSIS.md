# What works, what fails, and what was taken out

An audit of the repository as of v2.5.6, done by reading the sources rather
than the docs, running the suites, and running the demo. Every claim below
has a file and (where it matters) a line reference. Found defects were fixed
in the same pass; retired ideas were removed rather than documented as if
they still existed.

## How this was checked

```bash
node tests/run-tests.mjs        # 189 passing (172 before this pass; seventeen added)
node tests/run-tests.mjs "Nodes 2.0"        # the seven that cover that renderer
node tests/run-tests.mjs "cache on disk"    # the five that cover the picture store
node tests/run-tests.mjs "stand-in picture" # the five that cover what a picture holds
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

## Nodes 2.0 (the Vue-nodes frontend), verified against the frontend's own code

The question was whether this tool's drawing rules are still *true* on
ComfyUI's newer frontend. They were not, in three places. The contract was
read from the frontend's sources rather than inferred from behaviour:

| Upstream file (Comfy-Org/ComfyUI_frontend, `main`) | What it says |
| --- | --- |
| `src/composables/useVueFeatureFlags.ts` | `LiteGraph.vueNodesMode = settingStore.get('Comfy.VueNodes.Enabled')`, re-applied by a watcher — so the flag changes on a live page. |
| `src/composables/useGlobalLitegraph.ts` | `window.LiteGraph = LiteGraph`, so the flag is reachable from an extension. |
| `src/renderer/extensions/vueNodes/components/LGraphNode.vue` | Each node is `<div class="group/node lg-node absolute" data-node-id=…>` positioned by `transform: translate(x, y)`; no `left`/`top`. |
| `src/components/graph/DomWidgets.vue` + `widgets/DomWidget.vue` | DOM widgets live in `[data-testid="dom-widgets"]`, one `.dom-widget` per widget, `visible` from the node's own visibility; the wrapper is positioned in client pixels. |
| `src/composables/element/useCanvasPositionConversion.ts` | `client = (graph + offset) * scale + canvasRect.left/top` — the arithmetic the tracker's ownership maths inverts. |
| `src/scripts/domWidget.ts` | `addDOMWidget` defaults `hideOnZoom: true`; `BaseDOMWidgetImpl.draw` paints a placeholder when that and low quality are both set. |
| `useNodeImage.ts` / `useNodeAnimatedImage.ts` | Core video and animated previews pass `hideOnZoom: false` and never surface in a Vue node. |
| `LGraphCanvas.drawNode` (LiteGraph) | Returns immediately when `LiteGraph.vueNodesMode` is true. |

What that means for this tool, and what had to change:

| # | Finding | Evidence | Fix |
| --- | --- | --- | --- |
| 1 | **The stand-in engine was aimed at nodes the canvas never draws.** `lodFlatNode` already refused every node in Vue mode (correctly), so `lodFlatOn` was true, `lodSnapOn` was true, and the once-a-second lane still walked the graph queueing captures. A capture there draws nothing, so it would be written off as "draws nothing into the canvas" and blocked for the session — a dead end that also polluted the counters. | Reproduced in the fixture: 4 captures queued from `runFinish` alone. | `lodSnapOn()` returns false when the renderer is Vue nodes, with the reason in the code and in the Status line; the enqueue path inherits the guard. Test: *"the stand-in engine does not photograph nodes this renderer cannot draw back"*. |
| 2 | **The readout blamed the wrong thing.** With flattening switched on and the zoom below it, the Status tab said "snapshots are on but not painting anything: they replace flat boxes, so they need the flatten setting above switched on" — the opposite of the truth — and the flat line offered "collapsed boxes or this tool's own node" as the reason for `0 of 3` nodes flattened. | Panel text in the fixture before the fix. | A Vue-nodes sentence in the Status readout (renderer named in the first line, idle settings explained where their numbers would be) and the same in the copyable report. Test: *"the panel names the renderer instead of blaming the flatten setting"*. |
| 3 | **The DOM half did work whose answer was guaranteed to be "nothing changed".** With only node flattening switched on, the once-a-second sweep still built the registry and the per-frame pass still walked it; in Vue mode a flat decision cannot mark anything. | `lodSweepDom` / `viewApplyFocus` had no renderer awareness. | One predicate, `lodDomWanted()`, used by the sweep, the frame plan, the settings-apply path and the switch-on path: the focus half (widgets stop answering, the fovea) counts, the stand-in half only counts when this renderer draws nodes. Tests cover both halves — including a component widget (a 3D viewport), which is only reachable through the DOM widget layer. |
| 4 | **A warm cache survived the switch into this renderer.** The slice that drains the capture lane already stopped when the engine was off, but the bitmaps it had already taken (and a queue with work in it) stayed in memory for a page that can never paint them — a renderer switch is not a reload. | Reproduced: two held bitmaps and their bytes stayed after `enterVueNodes()`. | The slice releases the cache on that transition, the same release as switching the setting off, and counts it as a clear. Test: *"a page that switches to this renderer hands back the pictures it can no longer paint"*. |
| 5 | **Nothing pinned the flag to the live page.** A rule that latched the renderer at load would look correct in every test that sets the mode once. | — | The flag is read per call, and a test switches the renderer back *on the same page* and holds flattening and the picture engine to returning. |

### Could picture stand-ins work *in* the Vue-nodes renderer?

The question was asked directly, so here is the answer with its reasoning rather
than a shrug. Two halves, and they get different answers.

**What can work there, and does.** Link thinning and straight links (the canvas
still draws the ink), the idle redraw cap, the widget/focus settings and the
fovea (they act on DOM elements and the pointer), the governor, and every
measurement that is not per-node canvas drawing. The node's root element is still
never hidden for the *stand-in* settings — only the fovea, which is a different
promise (the node is off screen, so nothing about it is visible either way) and
works on Vue roots today.

**What cannot work as it is, and why.** The stand-in is a canvas bitmap blitted
in place of a canvas `drawNode`. In this renderer the canvas draws no node at
all, so there is nothing to blit *into*, and a capture of one is blank — the same
blank that used to be written off as "draws nothing into the canvas". A picture
could still be *shown*, but not through the canvas: it would have to be an
`<img>` (or a canvas) this tool appends to the vue-nodes container, positioned to
match the node, with the node's own root element taken out of the picture
(`visibility: hidden` keeps the box, so selection, drag and menus keep working).
That is a different feature with a different cost profile:

- The frontend re-renders a node's component when its data changes and owns the
  node's transform, so keeping an overlay in step means reading the root's
  transform every frame and writing it to our element — per-frame work this tool
  currently never does.
- The saving is smaller than in canvas mode: the browser still creates and mounts
  every node component; hiding a root skips its layout and paint (`content-visibility:
  hidden` would skip more, at the price of a collapsed box), but it does not skip
  Vue's own render of that component.
- Correctness risks are real and new: z-order against selected nodes and groups,
  the node's own DOM widgets layer (which the frontend positions independently),
  multi-select, and the frontend's re-mount on graph switch.

So: **feasible, not built, and not a small change.** It is recorded in `plan.md`
(Track K) as a design with its open questions, so it can be picked up on evidence
— the honest evidence being that on a large Vue-nodes graph the measurement shows
what fraction of a frame the node DOM actually costs, which this tool can already
report (frame budget plus the Stalls tab) before anybody writes the overlay.

Two things the Nodes 2.0 pass confirmed rather than changed: the Vue node's
**root element is never hidden or inerted** (`via: "root"` records are exempt from
the stand-in classes, and only widget wrappers are marked), and the canvas
settings that still reach ink — link thinning, straight links, the idle cap —
behave identically in both renderers.

The fixture (`tests/harness.mjs`, `enterVueNodes()`) is built to the upstream
shapes quoted above: `data-node-id` roots, the `dom-widgets` layer,
client-pixel `left`/`top` with `transform: scale()`, and `drawNode()`
returning early. It is a model of the contract, not a browser: no real
Vue-nodes page was executed in this pass (see *Still open*).

## The stand-in pictures: what a capture actually contains, and where the cache went wrong

The user's report was specific: image loaders and mask editors show a stand-in
with the node's UI but no image in it, text nodes (including the default
`CLIPTextEncode`) show no text at all, and the capture resolution and the disk
cache do not behave when the setting changes. All of it was real, and one item
was worse than reported.

**Why a picture had no image and no text in it.** A node's widgets live in DOM
elements *over* the canvas in both frontends, and the canvas row under them is
blank: `BaseDOMWidgetImpl.draw` (`src/scripts/domWidget.ts`) paints a
`WIDGET_BGCOLOR` placeholder **only** when the frontend's own low-quality mode
is on, and otherwise draws nothing. So a capture — which is the canvas — was the
node's chrome and nothing else for exactly the node types that are *made* of DOM
content: a prompt textarea, an image preview (`<img>`), a mask editor or a 3D
viewport (`<canvas>`). The picture was honest and useless.

| # | Finding | Evidence | Fix |
| --- | --- | --- | --- |
| 1 | **A capture ratio below 1x was not honoured.** `lodSnapRender` (and the ink probe) clamped the ratio with `Math.max(1, ratio)`, so 0.25x and 0.5x — settings since v2.5.2 — were drawn at 1x. The budget had been asked to reserve a quarter of the memory, the picture was allocated sixteen times it, and the readout called it "0.25x". | A 248x192-unit capture at `snapRatio: 0.25` produced a canvas smaller than 100px after the fix and 248px before it. | One `lodSnapPixelRatio()` used by the render and the ink probe, so they cannot disagree about the surface. Test: *"a ratio below 1 is drawn at that ratio, not at 1x with a smaller name"*. |
| 2 | **The disk file was keyed by the node signature alone.** The signature deliberately leaves out the capture ratio and the theme (in RAM both changes clear the whole cache), but a file outlives both: a page starting at 0.25x loaded yesterday's 1x files under the same name — and because a record then existed, it never re-captured them; a page starting at 2x was served 0.25x pictures and never asked for better; a picture drawn in a light theme was served in a dark one. | The disk key test shows the same node asked for with the same signature at ratio 1 and 0.25 in one session. | The disk key is `signature + r<ratio> + t<hash of the theme constants>`, used by the ask, the save and the install's verification. A change of either re-keys, so the setting is followed in both directions. Tests: *"the file is written under the ratio and the theme it was drawn with"*, *"changing the capture resolution re-asks in both directions"*, *"a file for another ratio is a miss, and a file for this one is loaded and used"*. |
| 3 | **A disk-loaded record claimed `ratio: 1` whatever the file held** (`rec.ratio = 1`), so nothing downstream could ever tell what it was looking at — and the save path would have written a picture the budget had coarsened under the *setting's* name. | Both are visible in the record and in the file name. | The ratio comes out of the file's own key; a picture the budget forced coarser than the setting is not written at all ("a file says what is inside it"). Test: *"a picture the budget forced coarser than the setting is not written to disk"*. |
| 4 | **Nothing put the node's DOM content into the picture.** No compositing existed: images and text were simply absent, and `snapPartial` only told the user that the picture was "the canvas part only". | The capture's own draw calls, in the harness: no `drawImage` of the node's `<img>`, no text of a `<textarea>`. | `lodSnapDomInk` draws, after the ink probe and before the mip chain and the file: images and canvases pixel for pixel; a text field's value re-painted in the theme's widget colours (page JavaScript cannot screenshot rendered text — the readout counts those separately and says so); a pack's own HTML left blank and counted. Geometry is the frontend's own rule (`node.pos + margin`, `widget.y`, `width ?? node.width`, `computedHeight ?? 50`) from `DomWidgets.vue` — no layout read, and it still works while this tool's own class has the wrapper hidden, which is the state a flat node is in. Tests: the five in *"what a stand-in picture contains"*. |
| 5 | **Nothing made a picture stale when its DOM content changed.** The signature covered the node's fields and `node.imgs`, but not the elements: a new image in a loader widget or edited text in a field that had not synced could keep an old picture indefinitely. | The image-arrival test: the picture with a blank spot lived on until the element was hashed. | The signature covers what the elements are showing (an image's `src`/`complete`/size, a canvas's size, a text field's value). Test: *"a text widget's value is painted into the picture, and editing it makes a new one"* and the image-arrival half of the test above. |
| 6 | **A video node could be photographed.** A still picture of a playing video is one frame presented as if it were the node. | — | `lodSnapHasVideo` keeps a node with a video element (or one inside a widget's element) live for the session. Test: *"a node playing a video is never photographed, however idle it is"*. |
| 7 | **An eviction could not be satisfied from disk.** `lodSnapEvict` released a bitmap for budget without forgetting the "already asked" mark, so the node was re-photographed even though its file existed (the RAM purge already did this correctly). | — | The eviction forgets the mark, like the purge does. |

Honest limits recorded in the code and the docs: the text is re-painted, not
screenshotted; a picture containing an image from another origin is tainted by
the browser, which allows it to be blitted but not read back, so that one
picture works in memory and cannot be written to disk (it is not counted as a
disk failure either); a pack's own HTML widget stays blank; and a pack that
keeps its preview element off the widget list (`widget.element` /
`widget.inputEl` is the frontend's own contract) is not reachable. The lookup
follows the frontend's own routes — `node.widgets[i].element`, then a single
`img`/`canvas` inside that element — and draws nothing when either would be a
guess.

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
- **A DOM-overlay stand-in for the Vue-nodes renderer** is designed but not
  built (see above and `plan.md`, Track K). Nothing here depends on it; the
  renderer is detected, understood and reported either way.
- **A picture with a cross-origin image in it cannot be written to disk.** The
  browser taints the canvas; blitting still works, so the picture is used from
  memory, and the write is skipped without counting as a disk failure. Not
  exercised in this pass (the harness's images are all same-origin fictions).
- **The Nodes 2.0 support is verified against upstream sources and the
  fixture, not against a running Vue-nodes page.** Every claim in the section
  above is traceable to a file in `Comfy-Org/ComfyUI_frontend` and reproduced
  by the harness, but a browser was not stood up with the setting on; the
  areas a fixture cannot model (real Vue re-render timing, a live widget
  store, the frontend's own `low_quality` transitions) are the ones to
  watch if the mode is used for real work.
- **The console-attribution mode** (plan.md, Track L) is still unbuilt. The
  credit for the idea stands; the honest thing is that nothing in the shipped
  code depends on it.
- **Upstream differences** are deliberate and documented: this tool waits
  60 ms before it declares a capture too slow (upstream cuts at 32 ms), and
  it refuses a node by measurement ("whatever the canvas draws") rather than
  by an upstream list of node types.
