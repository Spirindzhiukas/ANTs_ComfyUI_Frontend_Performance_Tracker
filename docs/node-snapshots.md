# ComfyUI-NodeSnapshots — what it does, and what this tool took from it

**Source:** `SparknightLLC/ComfyUI-NodeSnapshots`, `main`, read **2026-10-04**.
**Licence:** MIT, © 2026 (verbatim text in `THIRD_PARTY_NOTICES.md`), which is why
the ideas below could be reimplemented here rather than merely described.

This is the extension the stand-in feature learned from. It replaces the drawing of
a node with a cached bitmap in **both** renderers; its Nodes 2.0 support is marked
experimental in its own README. It is also the closest thing this project has to a
benchmark of the *other* implementation strategy — rasterise the live DOM — and the
reason that strategy is not the one shipped here.

## 1. How its Nodes 2.0 capture works

A picture is a **styled DOM clone through `foreignObject`**, not a canvas grab.
`web/dom-raster.mjs`:

- `clone_styled_node(source, w, h)` clones the live subtree and inlines every
  computed declaration into `style.cssText` (custom properties skipped), drops
  `id`/`class`/`style`/`on*`, copies an input's `value`/`checked`, and turns a
  textarea into its `textContent`.
- It **refuses** a node containing `canvas, video, audio, img, iframe, object,
  embed, script, link, style, use, [contenteditable]`, a shadow root, a scrolled
  element, an `animationName`, a `backdropFilter`, non-empty `::before`/`::after`
  content, or a non-`data:` `url()`. It forces `content-visibility: visible;
  contain: none; transition: none` on the clone.
- `DomRasterizer.prepare` inlines same-origin `@font-face` rules as data URLs; an
  external font means the node is refused.
- `decode()` = clone + `<style>` inside `<svg><foreignObject>` → Blob URL →
  `new Image().decode()`.

Two consequences matter for anyone comparing it with this tool:

1. **The refusals are the picture's content.** An image node, a mask editor, a
   video node, a canvas preview — everything the user actually looks at — is
   *unsupported* by this route and stays live. Its own issue #1 reports exactly
   that (`DOM/media nodes are never snapshotted`).
2. **A rasterisation is a full tree raster per capture**, on a machine where the
   point of the feature is that the browser stops spending CPU on nodes. Its README
   says the quiet part: *"Vue updates and layout still run, so a screenshot is not a
   promise of a speedup"*.

## 2. The lever this tool does **not** use: `content-visibility`

NodeSnapshots' main offscreen win is native containment on the node body:

```css
.lg-node [data-testid^='node-body-'] {
  content-visibility: auto;
  contain-intrinsic-size: auto var(--node-snapshot-width, 200px);
  overflow-clip-margin: 32px;
}
```

- The intrinsic size is **measured once while the body is still live** by one
  shared `ResizeObserver` (not guessed from the node's declared width).
- `:hover`, `:focus-within` and `:has([data-testid="node-state-outline-overlay"])`
  force the body visible again, so a node the user is touching is never a skipped
  subtree.
- A `MutationObserver` on the pane, a per-rAF loop bounded by a
  `capture_budget_ms` setting, and the `contentvisibilityautostatechange` event
  maintain a `skipped` set of bodies the browser has taken out of layout/paint.

**Why it is not used here.** NodeSnapshots documents its own price in its README:
while `content-visibility` is being applied the browser keeps reporting small body
size changes, which *discard images that were already captured and queue them
again* — diagnostics show it as repeated `resize` invalidation
(`vue.invalidations`), and on its benchmark workflow the dense view needed ~22 s of
idle time to warm while the overview still had ~100 of 344 nodes uncaptured at a
45-second cap. This tool's invalidation is a signature over measured geometry and
text; the same churn would re-make pictures here too, and it would be a
*behavioural* change (an element the browser no longer lays out is an element the
reader can no longer measure) that has to be validated on a live page with the
counters, not in a harness. It is recorded in `plan.md` (Track K) as a lever with
its price, to be tried only against the user's own page.

## 3. Its navigation levers

- A pane attribute removes `.lg-node` drop shadows while the camera moves, and
  comes off about 180 ms after motion stops. Variants zero `border-radius` or kill
  shadows entirely.
- Nodes 2.0 shades are Tailwind `drop-shadow-*` utilities; corners are `rounded-*`.
  The classic canvas is `render_shadows` plus the global `ROUND_RADIUS`.
- A stored image **bakes both**, so changing either has to rebuild the images.

This tool's equivalents are the "Reduce shadows during navigation" setting (deferred
to the next live verification) and, for the classic canvas, the same two LiteGraph
globals — with the difference that this tool remembers the value it replaced and
gives it back.

## 4. What its own README claims, and does not claim

Its benchmark table (Nodes 2.0, 344-node workflow) reports dense view 25.0 → 24.7
fps (no reliable gain), overview 18.0 → 22.2 fps, and says plainly that the
overview trials were still warming up and are a lower bound, that "no Nodes 2.0
speedup is claimed from this correctness check", that its validation is
frontend 1.55.9 in headless Edge on Windows, and that the dense-view gain is
within noise. Its known weak point is stated as warm-up: warm-up is not
steady-state drawing, and captures keep accumulating on the same nodes for as long
as the graph stays idle.

This is the same shape of finding as this project's own v2.7.2 measurement, from
the other side: the *rate of pictures* is what decides whether the feature is free
or expensive.

## 5. Issue #1 (`EricBCoding`), as reported there

- The camera marker shows only on reused images.
- DOM/media nodes are never snapshotted (see §1).
- "Slow node cutoff" 32 ms and "Max bitmap dimension" 2048 px keep oversized or
  slow nodes live.
- Captures run in small idle batches.
- **A log line per wheel event dropped a large graph to 5 fps with DevTools
  closed** — a reminder that a per-event cost this small is still a per-event cost.
- PanTextHider's only lever is raising `LiteGraph.min_font_size_for_lod` during pan
  and zoom. Hiding text *during a pan* saves nothing (the pane is
  compositor-promoted via `will-change: transform`; only zoom re-rasters), and
  toggling attributes invalidates style and paint pane-wide.
- In the non-canvas Legacy renderer, the live surface is the widget overlay
  repositioned with `left`/`top` every canvas frame.

## 6. What this tool took, and what it refused

**Took:** the idea of a picture stand-in in both renderers; the honesty rules that
follow from it (an unsupported node is *counted and left live*, never drawn as an
invented picture); the "nothing per frame in the steady state" bar; the diagnostic
vocabulary (`invalidations`, `last_invalidation`, capture counts and durations);
and the two classic-canvas levers for shadows and corners.

**Refused:** the `foreignObject` rasteriser (a prototype against documented
behaviour exists in this repo's history and is **not shipped** — there is no
browser in the development environment to A/B it against, and on the user's
target — Electron with hardware acceleration disabled — a full tree rasterisation
per capture is the cost the pathway exists to remove); and, for now,
`content-visibility` (§2).

**Not read:** its `web/index.js` (the rasteriser driver), `web/dom-cache.mjs`
(capture scheduling and retention), `settings.mjs`, `README` beyond the sections
above, `tests/browser.mjs` and `tests/benchmark.mjs`. Anything about its
scheduling, retention and browser-testing details that is not in this document is
not known here.
