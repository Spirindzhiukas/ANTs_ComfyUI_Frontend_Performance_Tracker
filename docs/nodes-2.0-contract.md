# The Nodes 2.0 renderer, as this tool reads it

**Source:** `Comfy-Org/ComfyUI_frontend`, `main`, read **2026-10-04**. None of this
is a stable public API — it is the frontend's own code, and every reader in
`web/tracker.js` is written so that a rename degrades to a hole and a counter
rather than to a wrong picture.

This document is the map. When a report says "the stand-in looks wrong in Nodes
2.0", re-verify the relevant row here first: the answer has so far always been in
one of these files.

## 1. The shape of the renderer

| Fact | Where it comes from | What this tool does with it |
| --- | --- | --- |
| `LiteGraph.vueNodesMode` is the renderer switch. | LiteGraph bridge | `lodVueNodesMode()` — the pathway is read per call, never cached across frames. |
| `TransformPane` (`v-if`) holds a `LGraphNode` per node in a `v-for`; `DomWidgets` mounts only when Vue nodes are **off**. | `GraphCanvas.vue` / `CanvasPane` | A node is a DOM element here; a widget with `element` set is mounted in the node's DOM by `WidgetDOM.vue` (`domEl.replaceChildren(widget.element)`), not by LiteGraph. |
| The pane transform is written directly; `will-change: transform` is toggled by `useTransformSettling(…, { settleDelay: 256 })`. | `useTransformSettling.ts` | The 256 ms settle is why this tool's own settle window is 300 ms; the pane is compositor-promoted, which is why this tool never tries to save anything by hiding text during a *pan*. |
| Vue-mode `drawNode` early-returns after `_setConcreteSlots()` and `arrange()` — LiteGraph draws nothing for a node. | `LGraphNode.drawNode` | The canvas under a node is empty, so a picture must be *drawn* by this tool from the DOM's own numbers. |
| Hit-testing uses `getSlotLayoutAtPoint`; `useNodePointerInteractions.ts` forwards the middle button only. | same | A stand-in keeps the element's pointer events because that is where a link drag starts. |
| `useVueNodeResizeTracking.ts` runs **one shared `ResizeObserver`**, early-returns in `linearMode`, and defers while the tab is hidden. | same | This tool's own watcher follows the same shape: one observer per node element, and it never reads layout to *find out* something a report could have told it. |

## 2. `LGraphNode.vue` — the element, piece by piece

| Part | Markup / geometry |
| --- | --- |
| Root | `group/node lg-node absolute isolate touch-none text-xs flex flex-col`, `data-node-id`, `data-collapsed`, inline `translate(x, y − NODE_TITLE_HEIGHT)`, `zIndex`, `opacity`. |
| State / selection outline | `pointer-events-none absolute z-0 border-3`, `-inset-1.75` for errors, `data-testid="node-state-outline-overlay"`. |
| Inner wrapper | `node-inner-wrapper`, `flex flex-1 flex-col bg-node-component-header-surface w-(--node-width)`, background colour from `nodeData.color`. |
| Body | `data-testid="node-body-<id>"`, `bg-component-node-background pt-1 pb-3`. |
| Progress bar | `absolute inset-x-0 top-1/2 -translate-y-1/2` with an inline `width` — the frontend's own, live. |
| Body order | slots → widgets → content → badges. |
| Footer | `NodeFooter` renders **outside** `node-inner-wrapper`. |
| Executing stroke | `#0b8ce9`; classic canvas error stroke `#E00` width 10 pad 12; canvas progress colour `LiteGraph.NODE_DEFAULT_PROGRESS_COLOR`. |

## 3. What the reader is built on

| Reader | Page feature | Notes |
| --- | --- | --- |
| Node root lookup | `[data-node-id]` | A cached element is trusted only while that attribute still names this node (this frontend reuses elements). |
| Structure (`lodVueChromeBoxes`) | `node-inner-wrapper`, `node-header-*`, `node-body-*`, `.slot-dot`, badge row + `data-testid="comfy-badge"`, footer tab `subgraph-enter-button` / `advanced-inputs-button` | Test ids and DOM relationship only — never a generated Tailwind class. |
| Widget rows (`lodVueWidgetBoxes`) | `node-widgets`, `.lg-node-widget` | Where the browser laid them out, not LiteGraph's `arrange()`. |
| Form and ARIA controls | `<input>`/`<textarea>`/`<select>` values, `role="slider"` + `aria-valuenow`, `aria-checked` | This frontend's widgets are reka components: a `Slider` is a div with a thumb, a `NumberField` is an `<input>`. |
| Icons | `mask-image: url("data:image/svg+xml,…")` + `background-color: currentColor` + `mask-size: 100% 100%` | The iconify Tailwind plugin (`packages/design-system/src/css/iconifyDynamicPlugin.ts`) compiles `icon-[comfy--comfy-c]` this way; the vocabulary is generated with `@source inline(...)` in `style.css`. **An icon is a data URL, not an element.** |
| Images and previews | `NodeContent.vue` → `ImagePreview` for `nodeMedia`; widget `element` for image/animated-image previews (`vueNode: 'never'`) | `IMAGE_PREVIEW_CONTENT_MIN_HEIGHT = 220` (`imagePreviewLayout.ts`), so a picture built from `node.size` alone clips exactly the preview the user wants. |
| Browser-screenshot floor | — | No page API draws a DOM element into a canvas (not `drawImage`, not `createImageBitmap`, not `captureStream`). The picture is drawn from measured numbers. |

## 4. Execution state — where the truth is

| Fact | Where it comes from |
| --- | --- |
| `node.progress` and `progressValue` are set only while a node runs. | `nodeProgressCanvasSync.ts` |
| `node.has_errors` is reconciled with `node:property:changed`. | `useNodeErrorFlagSync.ts` |
| In Vue mode there is **no execution state on the canvas** until this tool paints it. | Vue-mode `drawNode` early-return |
| A video or active link drag keeps the Vue element live. | `lodVueFlatNode` / `lodSnapLive` |
| Progress and error marks are read from the node each draw and overlay a held Vue picture. | `lodSnapPaint` → `lodSnapStateMarks`; they are excluded from the picture signature and capture queue. |

The stand-in no longer hands a running or erroring Vue node back to the frontend:
its progress bar and error stroke are painted over the held picture from the live
node fields, and clearing the fields removes the marks without a recapture. They
are never baked into a new bitmap. Video and link drag remain live-element
exceptions. The frontend's separate executing outline is still hidden with the
blanked DOM and is not reconstructed by this overlay. In the classic canvas
renderer, running/erroring nodes continue to be drawn live rather than served from
a picture.

## 5. The one thing this tool could not verify here

No browser can be obtained in the development environment, so every claim in this
document is a claim about **source code plus the Node harness** (`tests/harness.mjs`
models the DOM, computed styles, observers and the canvas). The live page has
already caught defects this harness could not: a class Vue rewrote wholesale, a
picture half switched off, a picture with no text in it, a zoom measured off the
wrong element, and a plan that fought the stand-in setting once per frame. Dark
control/background differences reported for Nodes 2.0 remain undiagnosed; the
harness tests operations and layout, not pixel equality. The user's CPU-only
Electron FPS comparison also remains open: the supplied report had low-zoom drawing
off, so it does not measure stand-ins on versus off. That paired live-page evidence
is required before claiming a performance change.
