# ANTs_ComfyUI_Frontend_Performance_Tracker

**ANTs Frontend Optimizer** — a frontend-side profiler *and* a small set of
drawing rules for ComfyUI. It answers the question DevTools makes you work
for: *which extension's JavaScript is actually costing me frames while I pan
this graph, and what is eating main-thread time that no draw hook owns?* —
without opening DevTools and without restarting ComfyUI to bisect.

Version **2.6.7**. Everything runs from page load: no node has to be placed,
nothing executes, and the tool never changes your graph or your workflows.

- **Measure** — per-extension and per-node-type frame cost, canvas draw
  stages, main-thread stalls, redraw-request callers, load time, memory, GPU.
- **Act** — mute a draw hook, cap a runaway timer, or turn a node into a
  stand-in bitmap below a zoom you pick. Every effect is opt-in, remembered,
  and reversible.
- **Say what it cannot see** — GPU cost per extension, Vue draws, Firefox's
  memory API and more are named as unmeasurable rather than guessed at
  (the canonical list is the LIMITS block at the bottom of `web/tracker.js`).
  A Vue-nodes stand-in is a *drawing*, not a screenshot, and the readout says
  which parts of a node it could not draw.

This README describes the current code. Version history moved to
[`CHANGELOG.md`](CHANGELOG.md); the rules for changing the code are in
`CLAUDE.md`; the decisions behind it are in `memory.md`.

## Install

Drop the whole folder into `ComfyUI/custom_nodes/` so that it sits at:

```
ComfyUI/custom_nodes/0000_ANTs_nasty_bastards_tracker/
    __init__.py
    web/tracker.js
    web/window.html
```

The `0000_` prefix is deliberate: web directories load in alphabetical
order, and this file must load **before** other custom nodes' scripts so it
can wrap their `registerExtension` calls and see their draw hooks. If you
rename it, keep something that still sorts first.

Restart ComfyUI. There is no build step, no bundler, and nothing to
`pip install`; the extension ships by being copied.

Two things are written server-side, and nothing else:

- **Node pictures**, if "Keep stand-in previews on disk" is on, under
  ComfyUI's `temp/ANTs_Frontend_Optimizer_THUMBNAILS/` folder — one PNG per
  node id plus a signature of what the node draws, at most 8 MB per file,
  swept after 7 days, deleted when the node is deleted.
- The panel's own settings and position, in the browser's `localStorage`
  (`ants.lowZoom.v1`, `ants-governor-v1`, `ants-tracker-corner-pos`,
  `ants-tracker-panel-box`, `ants-tracker-panel-size`).

The node (`Add Node → ANTs → ANTs Frontend Optimizer`) does nothing and has
no inputs, outputs or execution. Its only job is to carry its own tick/gear
buttons on the canvas for people who keep the floating pill hidden. The old
class key `ANTsNastyBastardsTracker` is still recognised, so graphs saved
before the rename keep working.

### Optional backend routes

`__init__.py` registers nine routes, best-effort, and the frontend works
without them:

| Route | What it is |
| --- | --- |
| `GET /ants_tracker/gpu` | Read-only `nvidia-smi` snapshot (utilisation, VRAM, temperature, power, process), cached 2 s. If `nvidia-smi` is missing the route says so and the GPU tab falls back to ComfyUI's own `/system_stats`. |
| `GET /ants_optimizer/thumbs/info` | Where the picture folder is and how much it holds. |
| `GET/PUT/DELETE /ants_optimizer/thumbs/{node_id}` | Read, write (`?sig=`), delete one node's picture. |
| `POST /ants_optimizer/thumbs/sweep` | Delete pictures older than a week. |
| `GET /ants_optimizer/window` | The separate-window page. |
| `GET/POST /ants_optimizer/ui` | The settings/telemetry link between the ComfyUI page and that window. Memory only: a revision, an origin, the current settings and the last report. Neither side is the master. |

## Use

The tracker starts recording the moment the page loads.

1. A small pill appears pinned to the screen (drag it anywhere; the position
   is remembered). It carries the same two controls as the tracker's node:
   the **checkbox** switches the whole tool off — hooks unwrapped, sampling
   stopped, every drawing change handed back — without forgetting your
   settings, and the **gear** opens the UI.
2. The gear opens the **separate window** at `/ants_optimizer/window`: its
   own page, centred on the ComfyUI window, for a second monitor. If the
   browser blocks the popup, the in-page panel opens instead and says why.
3. The **panel** can also be opened from the tracker node's own gear, and
   closed with `✕`. It has a header (Copy · On/Off · Pause · Reset · Window ·
   Close), a summary bar that is always visible, and ten tabs.

The two surfaces are one tool. Both read the same settings through
`/ants_optimizer/ui`, a change carries a revision and an origin so neither
side applies its own echo, and a live number is not a settings change. The
window shows five tabs — Node Rendering Settings, Status, Timing, Nodes and
Stalls — which is the reading half of the panel; the panel itself adds the
Governor, Load, Memory, GPU and Testing tabs. The window shows live telemetry
only while the ComfyUI page is open and answering; when that page is gone it
says so instead of pretending.

### The ten tabs

| Tab | The question it answers |
| --- | --- |
| **Node Rendering Settings** | The controls that change what is drawn (see the next section). |
| **Status** | One paragraph: what this page is, what the frontend reports about itself, and what the settings are doing right now. |
| **Timing** | Which extension's hooks cost frames, per hook, with off-frame time kept separate. |
| **Nodes** | Where the frame went inside LiteGraph's own calls, and per node type. |
| **Stalls** | Main-thread blocking that is *not* canvas drawing, with the script, the invoker, forced-layout time — and who asked for redraws. |
| **Governor** | The scheduler layer: every timer/rAF source the page registers, what it costs, the limit you can put on it, the off-thread lane and the long-frame traces. |
| **Load** | Startup cost per extension pack from Resource Timing. |
| **Memory** | JS heap and the tracker's own footprint, with a 60-sample sparkline. |
| **GPU / VRAM** | ComfyUI's `/system_stats` (torch's view), plus the optional `nvidia-smi` route. Says out loud that per-extension VRAM attribution is impossible from page JavaScript. |
| **Testing** | Deliberate traffic generators and the scripted-pan A/B benchmark. |

The panel remembers its position and size, the corner grip grows the edge you
drag, and the header can move it. Rows are keyed and updated in place: scroll
position and expanded rows survive the twice-a-second refresh, ordering is
frozen while the pointer is inside a table, and the panel slows its own
refresh (1 s above 6 ms per pass, 2 s above 12 ms) so measuring the page does
not become the page's problem.

## Node Rendering Settings

Everything here changes only its own subject: the node setting never moves a
link, the link setting never paints a node, and the widget setting never
touches either. All of it is off the moment you click **Back to full
drawing**, and "off" is a real restoration, not a memory of one.

| Setting | Choices | Default | What it does |
| --- | --- | --- | --- |
| Replace node previews with bitmap stand-ins at zoom levels | off — draw every node · below 5 · 10 · 15 · 20 · 25 · 30 · 40 · 50 % | **below 50 %** | Below this zoom a node is a flat box instead of a live draw. The decision is the zoom, never a node's pixel size. In the Nodes 2.0 (Vue-nodes) renderer the same setting blanks the node's own element and the canvas paints the same box in its place — see the section further down. Hover, selection and a drag keep the picture; a selected node gets a ring; a link drag, a running progress bar and an error still draw live. |
| Stand-in | plain fill · title bar colour · title + error ring + progress + muted · picture of the node | **picture of the node** | What the box is made of. *plain* is a fill, *title* adds each node's own title bar, *state* adds error rings, progress bars and muted dimming, *picture* stores a bitmap of the node and blits it instead. In the Nodes 2.0 (Vue-nodes) renderer *picture* works too, drawn rather than photographed — see the section further down. Changing this choice never hands an element back and forth: the nodes that were boxes stay boxes, and the ones that were pictures stay pictures, so the canvas does not flicker. |
| Keep these node types live | comma-separated node types | empty | Types never served from a picture, however far you zoom out. They keep the painted fill or draw live, and the readout counts them as "kept live on purpose", not as failures. |
| Stand-in capture resolution | 0.25× · 0.5× · 1× · 2× · 3× | **1×** | Pixels per graph unit in the picture. Below 1× the picture is a quarter (0.25×) or a half (0.5×) of the node's size — that is what makes it cheap to hold a thousand of them, and it is drawn at that size, not at 1× with a smaller name. Half and quarter copies are still made for the screen. Zoomed in past the ratio a picture is softer than live drawing, which is why a node being worked at is never served from one. Changing this value re-captures and re-keys the disk files (see below). |
| Stand-in memory (RAM) budget | 256 · 512 · 1024 · 2048 · 4096 · 8192 MiB | **4096 MiB** | How much RAM the pictures may hold. A full budget refuses a new capture rather than evicting a picture that is on screen (that is what flicker looks like). On Execute or Run-to-node, at 85 % system RAM the off-screen pictures leave memory; at 95 % all of them do. Disk files stay and are loaded back after the run. |
| Keep stand-in previews on disk | on · off | **on** | Store those pictures under `temp/ANTs_Frontend_Optimizer_THUMBNAILS/` and load them back next session. One file per node, named by the node's id and a key of what is *inside* the picture: the node's own signature **plus the capture resolution it was drawn at and a hash of the theme**. The key is the whole promise — a file written at 3× is never served to a page asking for 0.25×, and a file drawn in a light theme is never served in a dark one; a change of either re-keys the file, so the setting is followed in both directions. A picture the budget forced coarser than your setting is **not** written, because it is not what the setting asked for. A change overwrites the file; deleting the node deletes it. Disabled after 8 failures; the memory cache keeps working. |
| Idle redraw cap | 0 · 250 · 500 · 1000 ms | **0 (off)** | While nobody is touching the page, redraws are limited to this rate. One input event lifts the cap at once. |
| Link shape | spline · straight | **spline** | The shape of a link and nothing else. There is deliberately no "auto" that follows the node setting: a link must not change shape because a *node* threshold was crossed. |
| Link thinning | full link and node detail · links thinned below 100 · 80 · 60 · 40 · 20 % zoom | **links thinned below 60 % zoom** | Below this zoom links are stroked 1 px instead of 3 and lose the dark outline. Curves stay where they were — this is ink, and only ink. |
| Measure link thinning | button | — | Alternates thinning on and off on this page and compares the two halves, then puts the setting back. |
| Widgets stop answering | never (nodes stay live) · below 20 · 30 · 40 · 50 · 60 % | **never** | Below this zoom a node's widgets ignore the pointer. The nodes themselves still select, drag, edit and open their menu. |
| Widget's threshold linked to the picture threshold | checkbox | **on** | The higher of the two zooms wins, so a picture never sits behind a live widget. |
| Off-screen nodes | off · on | **off** | Off-screen nodes get the same boxed, inert treatment at every zoom, past the margin below. |
| Off-screen margin | 0.25 · 0.5 · 1 · 2 screens | **0.5** | How far outside the visible area a node has to be before its widgets are taken away. |
| Come back | all at once · 1 per frame · 4 per frame | **1 per frame** | How many off-screen nodes may be handed back per drawn frame. On-screen nodes come back immediately. |
| Display scale | auto · 1× · 1.25× · 1.5× · 2× · 2.5× · 3× | **auto** | Windows display scaling. Auto reads it at startup and re-checks; pin it if the Status line disagrees. |
| How widgets go | hide · inert | **hide** | *hide* takes the element out of the picture as well as out of the pointer's way; *inert* only takes pointer events away and leaves it on screen. Both add a CSS class and restore exactly what was there. |
| Way back | button | — | Back to full drawing: every drawing change off, the disk cache left as you set it. |

### What is inside a stand-in picture

A node is not only what the canvas draws. In both frontends a widget's content
lives in a DOM element *over* the canvas — a prompt is a `<textarea>`, an image
preview an `<img>`, a 3D viewport a `<canvas>` — and the canvas row underneath
is blank (ComfyUI paints a placeholder there only in its own low-quality
mode). A picture of the canvas alone therefore showed a text or image node's
chrome and nothing else. The capture composites what is honestly drawable:

| The widget's content | What the picture gets |
| --- | --- |
| An image (`<img>`, and an image inside a wrapping `<div>`) | The image itself, drawn at the widget's row — pixel for pixel. |
| A canvas (a 3D viewport, a mask editor, a curve editor) | The canvas as it stands at that moment, pixel for pixel. |
| A text field (`<textarea>`, `<input>`) | Its value **re-painted** in the theme's widget colours, wrapped and clipped to the row — a rendering of the text the widget holds, not a screenshot of the browser's rendering. The readout counts these separately for exactly that reason. |
| Anything else (a pack's own HTML) | Nothing: the row stays blank and the count of what could not be drawn goes up. Inventing a picture of arbitrary DOM would be inventing ink. |
| A wrapper with the real thing inside it | The image or canvas inside, if there is exactly one (`widget.element` holding the `<img>`). Two is a guess about which one you are looking at, so it is left blank and counted. |
| A `<video>` (or an element holding one) | The node is never photographed at all: a still picture of a video is one frame presented as if it were the node. |

The picture is re-made when anything it contains changes. The signature covers
the node's own fields (title, size, colours, mode, error, progress, widget
values, the images a node draws into itself) **and** what its DOM widgets are
showing — an image's source, its `complete` flag and its size, a text field's
value — so dropping a new image into a loader, typing in a prompt or a mask
editor redrawing invalidates the picture and the idle lane photographs the
node again. A picture taken before an image finished loading has a blank where
the image will be, and is replaced as soon as it arrives.

The lookup is the frontend's own contract — `widget.element` / `widget.inputEl`,
which is where ComfyUI's own nodes put their previews and text fields — so a
pack that keeps a preview element off its widget list, or that paints into a
detached canvas, is not reachable and stays blank and counted.

Two things this deliberately does not do: it never makes a node's picture out
of *live* state (a running progress bar, an error, a link drag and a video
keep the node live, as the table above says), and it never writes a picture it
could not fully make to disk when the budget forced it coarser than your
setting asked for.

### What these settings do in the Nodes 2.0 (Vue) frontend

ComfyUI's newer frontend can render every node as a DOM element
(`LiteGraph.vueNodesMode`, the **Nodes 2.0** setting). The canvas then draws
links, groups and the grid, and no node chrome. There is no *screenshot* to
take there — no browser API draws a DOM element into a canvas — but there is a
stand-in to paint and a picture to *draw*, so the tool runs a second pathway
behind the same settings and picks it from the frontend's own flag on every
call, never latched:

* **canvas renderer** — a picture of the node (or its box) blitted where the
  canvas would have drawn the node;
* **Vue-nodes renderer** — the node's own element is *marked* so the frontend
  stops painting it: its children are `visibility: hidden` (the one property an
  engine honours by skipping a subtree in the paint phase — `opacity: 0`, which
  this pathway used until v2.6.6, is still painted) and the element's own box
  keeps its place, transparent and hit-testable — selecting and dragging a node
  are bound on the root and never look at `event.target` — and the one thing
  inside left live is a slot's dot, because that is where a link drag starts. The
  elements stay in the page, in the layout and
  in the frontend's own observers, and the canvas paints the same box in the same
  place, with the same detail ladder. The mark is an **attribute** on the element
  (`data-ants-vue-standin`) plus an `!important` stylesheet rule, deliberately
  not a class: `LGraphNode.vue` binds `:class` on that element and rewrites it
  wholesale on every re-render, so a tool-added class is silently thrown away
  and the node comes back visible behind its box. The same reasoning applies to
  the fovea's hide mark on a node's own element and to its inert mark
  (`data-ants-dom-hidden` / `data-ants-dom-inert`). LiteGraph still calls `drawNode` for every visible node in this
  renderer — that is how it keeps slot metrics in sync — so this tool's
  existing seam fires with the context already in node-local space, and the box
  lands exactly where a picture lands in the canvas renderer.
  While the stand-in setting is **picture of the node**, each box also carries
  what the node is showing, drawn live, from the two places a node's content
  reaches the page. **Widget-borne content** (a prompt's `<textarea>`, anything a
  pack added through `addDOMWidget`) is drawn in the box the browser actually
  laid it out in when the frontend has mounted the element inside the node's own
  element (`WidgetDOM.vue` does; that is the route a text widget's value reaches
  the screen in this renderer) and otherwise at the row geometry the frontend
  positions it by. **Everything the node renders itself** — the frontend's
  `ImagePreview.vue` puts the node's pictures in `<img>` elements inside the
  node's DOM, and a custom node may render a `<canvas>` for a viewport or a curve
  editor — is found by walking the node's element and drawn at the position the
  browser laid it out in, which is readable while the node is a stand-in because
  the mark takes the *painting* away and never the layout: a hidden element still
  answers `getBoundingClientRect`, still has its text metrics and is still
  reported by every observer. **Everything the node renders as text** — its title, its
  widget labels and the values the frontend draws itself — is read out of the
  DOM, string by string, with the box the browser laid each one out in and the
  styles it computed for it, and re-painted there. Page JavaScript cannot
  *screenshot* rendered text, but it can read every string, its position and its
  font, which is what a stand-in needs; a field's *value* is drawn from the value
  the field holds, as before. The content is clipped to the node's box **and its
  title bar**, so the node's own name is in the picture rather than cut off above
  it. **The node's own structure** is read the same way and drawn the same way:
  the element's box (the coloured surface), the header bar that carries the title,
  the body panel under it and the connection dot of every slot, each at the rect
  the browser gave it and in the background colour the browser computed for it
  (the frontend's own `[data-testid=node-inner-wrapper]`, `node-header-<id>`,
  `node-body-<id>` and `.slot-dot`), and every widget's own row — the element the
  frontend mounts for it, with its background, border and radius, read in the same
  measurement pass so a row's rect and its colour can never come from two different
  layouts. Without that, the picture was the node's text
  and media floating on the canvas with no surface under them — the "semi, not
  fully there" the stand-ins were reported as. A pack's own drawn HTML is still blank and counted. Nothing is drawn twice, and **the page is asked for nothing while nothing
  changes**. The tool watches the node's element instead of interrogating it: a
  `ResizeObserver` on the element and the elements inside it, and a
  `MutationObserver` on its children and text, drop the stored measurement the
  moment the page reports a change — a widget row moving, content arriving, the
  element growing — and the next frame re-measures it through a ration of a few
  node layouts per frame. Everything downstream follows from that one
  measurement: the box, the ink, the signature that decides whether a stored
  picture is still a picture of this node, and the capture surface the picture is
  drawn on, so a node that grew or gained content cannot be photographed at the
  height it had a moment earlier and then clipped. Panning and zooming cost no
  read at all, because every number stored is node-local and a transform is not a
  box change. On a page without those observers the tool falls back to asking on
  a timer, and the ration still bounds what a frame may ask. In the steady state
  — pictures held, nothing changing — a frame costs the page **no** DOM write, no
  layout read and no DOM query of any kind, at any node count: the tool's whole
  per-frame cost is the blits it was asked to make: the whole canvas work of a
  frame in the steady state is one `drawImage` per boxed node and nothing else.
  Measured at 40 boxed nodes in
  the Vue-nodes renderer, 2.6.4 alongside, steady state: attribute writes per
  frame 40 (every one of them a re-write of a mark that had not changed) → 0, DOM
  queries per frame 82.4 → 0, layout reads per frame 2.4 → 0; at 150 nodes
  150 / 302.1 / 4.5 → 0 / 0 / 0.
  The box covers the **box the frontend rendered**, not the node's graph size:
  `LGraphNode.vue` renders an image node `IMAGE_PREVIEW_HEIGHT_RESERVE`
  (220 + 8 + 4 px) taller than its graph size and puts the picture in that
  reserve, so a box built from `node.size` would clip off exactly the picture
  being looked for. The element's own rect is measured, divided by the zoom the
  *element* is laid out at — read from the frontend's own transform pane
  (`[data-testid=transform-pane]`, one computed matrix for the whole graph, and
  the first answer), then from the element that carries the node's declared
  width, then from the node's root, and only from `canvas.ds.scale` if nothing
  about the DOM can be read at all (which the readout says, because a capture
  sets that number to 1 while the DOM keeps the frontend's transform) — so
  content lands where it belongs even in a capture taken mid-zoom.

**In this renderer the mark is the mechanism, and v2.6.6 is where it became one.**
A stand-in has to make the frontend stop *painting* the node — that is the whole
saving in a renderer whose node drawing is ordinary DOM work, and on a machine
with hardware acceleration off it is CPU work on every frame. `opacity: 0`
(v2.6.0–v2.6.5) does not do that: an opacity-0 subtree stays in the render tree
and is still painted, which is exactly why the stand-ins could cost performance
here while saving it in the canvas renderer, where the expensive drawing was
LiteGraph's own `drawNode` and the box replaced it. What an engine actually skips
is a *hidden* subtree, so the node's children are `visibility: hidden` — and only
its children: the node's own box keeps its place and stays hit-testable (which is
what keeps selecting and dragging a node working through a stand-in — both are
bound on the root), and the slot dots are re-shown inside the hidden subtree, since
a link drag starts on the dot and the canvas renderer keeps linking working through
its own canvas hit test. Nothing is removed: the elements stay
in the page, in the layout and in the frontend's own `ResizeObserver` (upstream
`useVueNodeResizeTracking.ts` measures the same rects), so every number the box and
the picture are made of still comes from the DOM, and a change inside a stand-in is
still reported and still re-makes the picture. What the mark trades away is the
*painted* node, not the node: a widget inside a stand-in no longer receives its own
clicks at that zoom — the pointer goes to the node, which is what the user sees
there — and the node's accessibility-tree entry is that of a hidden subtree while
its picture stands in. **Both halves are measured and pinned by tests:** the paint
the frontend no longer has to do is counted (`vuePaintSkipped`), a box that changes
inside a stand-in is still reported (and the picture re-made), and with the
stand-ins on a frame costs the page no attribute writes, no layout reads, no DOM
queries and no computed styles, at 40, 60 and 150 nodes alike. What page JavaScript
cannot measure is the rasteriser's own bill; on the machine the graph runs on, that
is what DevTools' *paint flashing* shows (boxed nodes stop flashing) next to this
tool's frame budget and Stalls tab. Every marked element is handed back the moment the
zoom leaves the setting, the setting or the tool is switched off, or the
renderer changes — the per-frame plan compares one boolean in the steady state,
so a stale mark cannot be left behind, and an element the frontend unmounted
mid-flight (it renders the whole pane with `v-if`) has the mark taken off it
too, so a reused element does not come back invisible. That plan asks the *same*
predicate the draw loop does, in one function: a mode that is not a picture is
not a reason to stop standing in, so nothing is handed back and forth while the
setting rests — which is what a per-frame fight between the two would look like,
nodes flickering between a box and the frontend's own rendering.

**Pictures work here as well, and so do the disk files.** Below the threshold
the idle lane builds a stand-in *picture* for each boxed node — not a
screenshot of the element, which no browser API can make, but the same drawing
the live box makes (the box, its title bar and state marks, the node's structure
read out of the DOM — surface, header, body panel, slot dots — every widget's own
row, drawn with the box, border and radius the browser gave it — and the reader
is sized for a real node rather than a fixture: 256 text lines, 400 characters per
string, 96 widget elements, 128 structural boxes and 96 slot dots, the widget text the
frontend mounts as DOM, and the node's own `<img>`/`<canvas>` elements at the
rows the layout gave them) drawn into the same offscreen capture surface the
canvas renderer uses. **A node is only photographed once it has stood still**: a
settle window (300 ms) opens when a node is first drawn as a stand-in and re-opens
on every change the page reports or the signature notices, so a burst of rendering
costs one picture at the end of it instead of one picture per step. The window
is a grace period and not a veto: a node that keeps changing past
`LOD_SNAP_SETTLE_MAX_MS` (900 ms, measured from the first change of the burst) is
photographed anyway. **And a change no longer takes the picture away**: what is on
screen is a complete picture of the moment before, so it stays there while its
replacement is made — a node whose value changed used to fall back to a plain box
until the new picture arrived, and a node whose value changes often was never
anything but a box (measured: 1020 of 1800 frames on a 24-node graph at the zoom
this feature is for, against 17 now). A node still out of date after 2 s (it is
changing faster than the lane can photograph it) gets its box back for 2 s and
keeps being asked; a capture that turns out slower than 60 ms buys a doubling
cooldown (10 s, 20 s, 40 s …, capped at 120 s) rather than blocking that node for
the session — the readout counts the cooldowns and says when the next try is. That is the
answer to a node being photographed while the frontend was still filling it in —
the frontend mounts a node and then writes its parts over the following frames,
and an image is decoded when it is decoded, so "capture immediately" is a picture
of a half-built node. **The capture lane is this tool's own, and that is
deliberate**: it runs on the idle lane (32 ms between slices, a 12 ms budget per
slice, nothing while the page has had input in the last 400 ms) rather than on the
frontend's own tick, because upstream has no per-node tick to ride — in this
renderer nodes are Vue components, the transform is one property on one pane
(`useTransformState.ts`), and what looks like tiers is the frontend mounting a node
in passes (the component, then `NodeSlots`' watcher, then the layout store's size,
then `NodeWidgets`, then `NodeContent` and the media) with its own notion of a
settled gesture (`useTransformSettling(…, { settleDelay: 256 })`, which is why the
window is 300 ms). A browser's incremental rasterisation is not observable from
page JavaScript, so the honest form of "capture the node the way the user sees it"
is to read what the browser laid out and computed, which is what this does.
Everything downstream is therefore identical: the capture
resolution ladder (0.25× → 3×), the half and quarter mip copies blitted on
screen, the RAM budget, the disk cache and its key, and the files in
`temp/ANTs_Frontend_Optimizer_THUMBNAILS/`. **The key names the pathway** —
`…r<ratio>t<theme><pc|pv>`, canvas or Vue — because the two pictures are not
interchangeable: one is a photograph of LiteGraph's own drawing, the other is
this tool's drawing of the node's DOM. A picture made in one renderer is never
reused in the other, in RAM or from disk: switching renderers releases what was
held and makes the pictures again, and a file written before that token existed
is re-made rather than served. **A node whose element is not on the page is
never photographed** — the picture *is* that element, so what the tool could
draw then is a bare box, and a bare box stored under the node's key would be
served to every later frame as if it were the node. It is drawn as a box
instead, and counted (`vueNoElement`). What stays impossible is a pack widget that is
neither an image, a canvas nor plain text (its own HTML): it is blank in the
picture and counted, exactly as in the canvas renderer.

| Setting | In the Vue-nodes frontend |
| --- | --- |
| Replace node previews with bitmap stand-ins at zoom levels | **Works, as boxes.** Below the setting each node's element stops *painting* — its contents are `visibility: hidden`, which an engine skips in the paint phase, and it stays in the layout and in every observer — and the canvas draws its box; above it, every element is handed back. |
| Stand-in (plain / title / title + state) | **Works** — the same box ladder, same marks, same colours, and no content drawn (that is what "plain" means here too). Choosing one of these instead of *picture* changes nothing else: the elements stay handed over and the boxes keep standing, frame after frame. |
| Stand-in: *picture of the node* | **Works, drawn rather than photographed.** No browser API can draw a DOM element into a canvas, so a screenshot of a Vue node is impossible; the picture is instead *drawn* — the box at the picture level (title bar, error ring, progress, dimming) with the node's own structure (surface, header bar, body panel, each widget's own row, slot dots, at their laid-out rects and computed colours) and its content: the images and canvases the node renders (the frontend's preview `<img>` elements among them) at their real laid-out position, text fields re-painted, a pack's HTML blank and counted. A node is photographed only after it has stood still (300 ms, re-opened by every change), so the picture is of a finished node, never of one still being filled in. Until the idle lane has that picture, the box carries the same content live. |
| Capture resolution, RAM budget, disk cache | **Work.** The picture is made on the same idle lane, at the same resolution ladder, with the same mip chain, RAM budget and disk files (`temp/ANTs_Frontend_Optimizer_THUMBNAILS/`, keyed by signature + ratio + theme + pathway). Switching renderer releases the pictures the other renderer made and builds them again, because the box, the padding and the content route all differ. |
| Keep these node types live | **Works** — a listed type is never blanked and stays in full detail at any zoom. |
| Link shape, link thinning, Measure link thinning | **Work.** Links are still drawn by the canvas, so the 1 px/no-outline thinning and the straight-line style reach the ink exactly as in canvas mode. |
| Idle redraw cap | **Works** — it caps the canvas redraws, nodes or not. |
| Widgets stop answering, off-screen nodes, margin, come back, display scale, how widgets go | **Work.** These act on DOM elements and on the pointer, which exist in both renderers. The stand-in pathway is the only thing that blanks a node's own root element, and only below your threshold; the widget and focus settings never touch it. |
| The governor, Timing, Stalls, Nodes, Load, Memory, GPU tabs | Unaffected: they measure timers, main-thread stalls, redraw requests and resources, not node painting. In this renderer the Nodes tab's per-type table is the frontend's own per-node layout pass (it draws no chrome), and the readout names the renderer next to it. |

The Status tab names the renderer and the pathway in its first line
("Vue nodes", "blanked", "boxes"), says how many pictures are held, and — when
the stand-in setting itself is off — says that pictures are made here too
rather than leaving the reader to guess, so a setting that is quiet for a
structural reason is not mistaken for a broken one. Switching Nodes 2.0 off in ComfyUI's
settings takes effect on the same page — the flag is read per call, not latched
at load — and the elements this tool blanked are handed back in the same frame.

Retired: the v2.1.5 separate image-preview thumbnail ladder. The node's
picture *is* the thumbnail — a second, hidden copy of an image that is
already a bitmap never paid for itself, so the setting answers `0` and
cannot be re-enabled by a script or a saved record. `lowZoom.previews` still
exists so old scripts get an answer rather than `undefined`.

## Reading the numbers

Every cost in the Timing and Nodes tabs is given in **four units**, and the
first is the one to reason with:

| Unit | Meaning |
| --- | --- |
| `ms/frame` | milliseconds of work added to the average drawn frame |
| `% fr` | that cost as a share of the average frame in the same window |
| `ms/call` | cost of one invocation (spikes vs. steady load) |
| `calls/fr` | how often it runs per displayed frame |

`ms/frame` and `% fr` are what let you compare a row to the 16.6 ms budget of
a 60 fps frame, to another graph, or to the same graph a minute ago. They do
not change if you pan faster; v1's window sums did. Rates (`fps`,
`requests/s`, stalls/s) are wall-clock and say so.

**Windows.** Hook and node-type costs cover the last 4 seconds. Frame
statistics cover 10 seconds, and widen to 30 seconds when a redraw cap
leaves fewer than 4 frames in the window, so a 1 fps cap still produces
meaningful `fps` and p95 numbers instead of `0`. The panel prints which
window it used.

**Sorting and long lists.** Every column header in the Timing, Nodes and
Stalls tables is a sort button: click to sort, click again to reverse, a
third time to return to the default. Sorting uses the underlying numbers,
never the displayed text (`1,234.5ms` sorts after `9.2ms`), and a row with no
value (`—`) sorts last in both directions — a dash means unmeasured, not
cheap. A thousand-node graph produces hundreds of owners and types, so the
tables render the most expensive 120 owners / 60 node types / 60 scripts /
60 tick sources and print how many are hidden, with a **Show all rows**
button per tab. The caps live on `window.__antsTracker.rowCaps`.

### Timing tab

Rows are *other* extensions; this tracker never lists itself. Columns:
`ms/frame`, `% fr`, `ms/call`, `calls/fr`, plus `off-frame ms` — hook time
that ran outside a canvas draw (`onExecuted`, a timer, a DOM event).
Off-frame time is real cost but it is not part of a frame, so it is kept out
of the budget instead of being folded into the next frame.

Red is above 15 % of the frame, orange above 5 %, both relative to the frame
budget rather than an absolute millisecond count.

Expand a row (▸) for the per-hook breakdown. Node types that assign their
**own** `this.onDrawForeground = …` inside `onNodeCreated` are adopted while
drawing and listed as `(unattributed) <Type> · instance hook`; hooks that
already existed on a prototype before this extension loaded are labelled
`(pre-existing) <Type>`. When a hook delegates to another wrapped hook, the
outer row carries the milliseconds and the inner one is tagged **nested**:
its calls are counted, its time is not, because the outer hook already
contains it.

### Nodes tab

Where the frame went, measured around LiteGraph's own calls rather than
through extension hooks:

- **drawNode** — per-node chrome, split into `wrapped hooks` (the part the
  Timing tab accounts for) and `LiteGraph chrome` (everything else).
- **drawConnections** — link rendering.
- **everything else** — the rest of the frame. If this line is big, the cost
  is in a canvas method this tool does not wrap, a widget's own `draw()`, or a
  Nodes-2.0/Vue component; the Stalls tab is the next place to look.

A per-node-type table follows, sortable by any column. `calls/frame` is calls
per redraw of the canvas, so for a type painted every frame it is close to
the number of instances on screen, and a value well below 1 means most of
that type was off-screen or culled. The interesting pair is `% of frame`
(how much of the budget this type eats) and `ms/call` (one heavy node or many
cheap ones).

### Stalls tab

Frame cost is not the only way to lose FPS, so this tab reports main-thread
blocking *outside* the draw path, from Long Animation Frames (Chrome 123+)
with a `longtask` fallback. Columns, all sortable:

- **blocking ms/s** and **stalls/s**, the headline numbers.
- **where** — script URL, function name, source line, and the extension pack
  when the script lives under `/extensions/`. Scripts from ComfyUI's own
  bundle appear as `assets/<file>.js` with pack `unknown`, which is itself
  the answer: it is the frontend, not a custom node pack.
- **invoker** — e.g. `TimerHandler:setInterval`, which names the mechanism
  behind a heartbeat.
- **count / blocking / % of blocking / ms per stall / worst** — a high count
  with a low ms-per-stall is a cheap heartbeat; a low count with a high
  ms-per-stall is one expensive operation worth a DevTools trace.
- **forced layout ms** — style/layout time inside the long frame, the
  signature of a DOM-thrashing extension.
- **redraw requests/s by caller** — `canvas.setDirty()` wrapped exactly (the
  rate is precise) and its call stack sampled ~20×/second to say *who* is
  asking. A rogue heartbeat shows up here by name.

This tab also names **this panel** when the panel itself stalls the thread —
look for `tracker.js` — and the Memory tab's "tracker's own footprint" block
gives the per-second cost. If those numbers are not small, it is a bug.

### Governor tab

The scheduler layer measures every `setInterval`, `setTimeout` and
`requestAnimationFrame` the page registers after this module loads, by
source, and each source can be given a limit:

| Limit | Effect |
| --- | --- |
| normal | measured only: same call, same arguments, same ids |
| ½ speed / ¼ speed | one run per 2× / 4× the delay it asked for (floored at 33 ms / 66 ms) |
| 2 /s, 1 /s | one run per 500 ms / 1000 ms |
| paused | the callback is not run at all |

Two rules make it safe to leave switched on:

- **A source on "normal" is untouched.** Same arguments, same `this`, and
  the ids returned by the platform functions are the browser's own, so
  `clearInterval`, `clearTimeout` and `cancelAnimationFrame` keep working.
- **A limited source is slowed, never silenced.** A skipped interval tick is
  covered by the next one; a skipped one-shot or chained callback is
  re-scheduled for when its window opens, and a callback that re-registers
  itself is respected. The only exception is "paused", which is exactly what
  it says.

Above the table: the frame budget, the rAF governor (`off` = measure only,
`adaptive` = skip rAF ticks while the main thread is behind the budget and
input is quiet, or a fixed floor in Hz), redraw merging, the input guard and
the trace threshold. Limits and controls live in `localStorage`
(`ants-governor-v1`), so a tuning session survives a reload; **Reset to
untouched** clears them, and **Suggest limits from this session** proposes a
limit per source from its measured cost — nothing is applied until you pick
it. **Turn the layer off** restores the browser's own functions immediately.

**Autopilot** (off by default) caps the worst source it is allowed to touch
every five seconds until the limitable sources are under the target you set
(150/250/400/600 ms/s), then stops and prints what it did. When the row it
just capped is still the worst thing on the page it steps the same row up the
ladder next round; when a row reaches 1/s and is still too expensive it says
so instead of pretending the problem is handled. It never touches the
tracker's own timers, never touches rAF loops (those have their own
governor), and never touches a limit you set by hand.

Two rules decide whether a limit does anything at all:

- **A limit has to be wider than the source's own period to bite.** A timer
  that asks for 10 ms but takes 300 ms of work runs every ~300 ms, so "half
  speed" (33 ms) changes nothing for it; only `2/s` or `1/s` do. The row's
  `allowed` cell says `33ms — no effect`, and both the autopilot and
  **Suggest limits** skip the multipliers for such a source.
- **The ranking is by cost, not by rate.** The real offenders usually run
  one to three times a second, so filtering on "runs often" misses them
  entirely.

Also on this tab: the **off-thread lane** and the **long-frame traces**.

- The off-thread lane is a worker that can run pure compute (a named job plus
  structured-cloneable arguments, or a self-contained function source) with a
  deterministic sanity check that compares the two threads' answers. Only
  pure compute can leave the main thread — Vue's render, the DOM and canvas
  drawing are main-thread-only by specification, and OffscreenCanvas only
  helps an application that created its canvas that way (ComfyUI does not).
  When the page has no Worker, the lane says so and answers on the main
  thread instead of pretending. Today its only shipped job is that sanity
  check plus the `offload` API — no page work is moved off the main thread
  yet, and the lane does not claim otherwise (real aggregation work is
  Track G in `plan.md`).
- The trace card lists long frames, worst first, with the scripts the browser
  named, the governed ticks that ran inside them, and how many redraw
  requests arrived while it was blocked. Expand a row for the per-script and
  per-source breakdown.

### Load tab

Startup cost per extension pack from the browser's Resource Timing entries:
transferred bytes, file count, the span from the pack's first fetch to its
last, and the slowest single file. Spans overlap, so they are not summed; a
pack with many files, a long span and a high slowest-file time is the one
blocking first paint. Runtime cost is not here — that is the Timing, Nodes
and Stalls tabs.

### Memory tab

`performance.memory` (Chrome) with a 60-sample sparkline, ring-buffer
occupancy, and the tracker's own footprint: panel rendering µs/s and
bookkeeping µs/s, with the refresh backoff state. Firefox exposes no
`performance.memory`, so this tab stays empty there by design and says so.

### GPU / VRAM tab

ComfyUI's `/system_stats` (torch's view per device: allocated, reserved,
free) plus the optional `nvidia-smi` snapshot (driver view: utilisation,
VRAM, temperature, power, process). Actionable readings: headroom under
~10 % means the driver will start evicting to system RAM, which shows up as
multi-hundred-millisecond frames and is not a JavaScript problem; a large gap
between torch "allocated" and the driver's "used" means fragmentation, which
is fixed on the Python side (`PYTORCH_CUDA_ALLOC_CONF`, `--reserve-vram`),
not in any node's frontend code. Per-extension VRAM attribution is not
possible from page JavaScript — that is a sandbox boundary, not a missing
feature.

### Testing tab

- **Redraw throttle presets** — deliberately hand the canvas a fixed redraw
  gap (30 fps down to 1 redraw/10 s) to see what a cap would buy.
- **Synthetic tick** — off, or force a redraw at a fixed rate from 5 s to
  16 ms, to reproduce "something is ticking" with a number attached.
- **Scripted pan benchmark** — a deterministic pan for 3 / 6 / 10 seconds
  (6 s default), run as A and then B over the same span (one screen plus the
  fovea margin), so a mute or a setting change is priced with the same
  motion. The two runs are what the mute feature is judged against.
- **Sampling state** — Pause / Reset samples / Unmute everything.

## Muting

"Mute" skips that owner's draw hooks outright, so the FPS change you then
measure is real rather than merely unmeasured, and it is reversible
instantly. A muted owner always keeps a row, even at zero activity, with a
way to unmute — a mute must never become invisible. Because a muted extension
may take a different code path on the next call (caches, internal state),
treat a muted/unmuted delta as an **upper bound**, not an exact price.

## What this cannot catch

The honest list is the LIMITS block at the bottom of `web/tracker.js`; the
short version:

- Anything drawn by a widget's own `draw()`, a Vue component (the Nodes 2.0
  style frontend) or an unwrapped canvas method is not attributed by name —
  it still lands in the frame budget's "everything else" line and in the
  Stalls tab.
- Redraw callers are sampled (~20/s) plus an exact total rate; a source that
  requests redraws in rare bursts can be missed between samples.
- GPU time and per-extension VRAM are not obtainable from page JavaScript in
  any browser.
- Firefox exposes neither `performance.memory` nor long tasks, so the Memory
  and Stalls tabs stay empty there by design.
- The scheduler layer can only govern callbacks that reach the page's own
  timer/rAF functions: microtasks, promise chains, browser-internal work
  (style, layout, paint, compositor threads) and a loop that never
  re-registers are outside its reach.
- A snapshot is a picture of the node at the moment it was captured, checked
  against the node's signature at most every 100 ms; a change between two
  checks can be shown stale for that long. Anything the panel can see cheaply
  — selection, hover, an error, a progress bar, a drag — is checked every
  frame and never uses a bitmap.

## Compatibility

- Chrome/Chromium gives the full panel (Long Animation Frames on 123+).
  Firefox and Safari have no long-task or `performance.memory` API, so the
  Memory and Stalls tabs are empty there by design; everything else works.
- ComfyUI's classic canvas frontend is fully covered. In the Vue-based
  ("Nodes 2.0") frontend the canvas draws links, groups and the grid only, so
  the node stand-in settings are idle by design (see *What these settings do
  in the Nodes 2.0 (Vue) frontend*); link ink, the idle redraw cap, the widget
  and focus settings and every measurement still apply. Node visuals that are
  DOM rather than canvas cannot be attributed by name, and that frontend also
  exposes no LOD threshold on the canvas — the Status tab says both.
- Nothing here depends on a specific ComfyUI version; every patch fails open
  and says so in the console rather than half-applying.

## Development

```bash
node tests/run-tests.mjs              # all tests — 222 passing, zero dependencies
node tests/run-tests.mjs <substring>  # one suite or test
python3 tests/test_init.py            # the Python side (routes, node contract)
node tests/demo.mjs                   # prints what every tab says, against a synthetic graph
node tools/pill-preview.mjs > preview/pill.html   # regenerate the pill page
node tools/box-preview.mjs  > preview/boxes.html  # the flat boxes at each detail level
```

The suite runs `web/tracker.js` **unmodified** in Node against a fake browser
and a fake ComfyUI (`tests/harness.mjs`), with a clock you control. There is
no npm, no bundler and no jsdom: the extension's only dependency is ComfyUI
itself.

`CLAUDE.md` is the operating manual (golden rules, the end-to-end recipe for
adding a setting, testing seams, release checklist); `ANALYSIS.md` is the
works/fails audit with the fixed defects and the retired ideas;
`memory.md` is the decision history. `preview/` is generated and never
hand-edited. Reusable pieces you can call from a console are on
`window.__antsTracker` — `snapshot`, `report`, `open`/`close`, `lowZoom.*`,
`link.*`, `governor.*`, `runStart`/`runFinish`, `ramCheck`, `rowCaps`.

## Credits

Ideas, designs and one example app from other people went into this tool.
Where code was ported, it was re-implemented on this file's own seams,
budget and idle-lane design; the licences of the upstream projects are
reproduced in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

- **[ComfyUI-NodeSnapshots](https://github.com/SparknightLLC/ComfyUI-NodeSnapshots)**
  — SparknightLLC / EricBCoding, MIT. The stand-in pictures are this tool's
  version of their idea: capture a node off-frame into a bitmap and blit it
  instead of redrawing it. What was taken: that a snapshot replaces a *flat
  box*, never a live node; that the capture has to run off the frame clock,
  with its own attribution so the packs' hooks are not blamed for it; the
  per-node signature so a stale picture is never shown; and that a node which
  is too slow to capture is left live for the session (upstream cuts at
  32 ms; this tool at 60 ms). What this tool added on top: the ratio ladder
  (1× default, coarser under budget pressure), and — since 2.4.0 — no
  upstream-style refusal list, but a named reason in the readout for every
  node that stays a box. What was deliberately not taken: the
  upstream refusal list of node types — 2.4.0 replaced it with "whatever the
  canvas draws", measured — and its fixed 2 px-per-graph-unit capture size,
  which is what makes a 1000-node graph run out of budget; the ratio here is a
  setting that defaults to 1×. Separately, the image-preview thumbnail ladder
  was this tool's own experiment, tried in v2.1.5 and retired in v2.5.0 (see
  Node Rendering Settings); it never came from upstream.
- **[ComfyUI-DisableBrowserLogs](https://github.com/SparknightLLC/ComfyUI-DisableBrowserLogs)**
  — SparknightLLC / EricBCoding. Its measured case (one `console.log` per
  wheel event taking a large workflow to 5 FPS with DevTools closed) is the
  source of the *idea* for a console-attribution mode: count and attribute
  console traffic per owner before offering to mute it, never mute
  permanently. That mode is not built yet (plan.md, Track L); no code was
  copied from that repository, and no licence file is shipped at its root,
  so it is credited as an idea, not as a dependency.
- **`examples/pop_up_window`** — the console example in this repository
  shaped `/ants_optimizer/ui`: a revision plus an origin so a live number is
  not mistaken for a settings change, and neither side of the link is the
  master. It is a reference example, not part of the extension.
- **ComfyUI** (comfyanonymous and contributors, GPL-3.0) supplies the
  extension APIs this tool is built on (`app.registerExtension`, the canvas
  draw hooks, `/scripts/app.js`, `/system_stats`), and its own `console`
  chatter is why a log mode is on the roadmap at all.
- **Chrome's Long Animation Frames API** and `performance.memory` are used
  as documented, including their absence on other browsers.

## Licence

See [`LICENSE`](LICENSE) for this project, and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for the notices carried
with it. Version history: [`CHANGELOG.md`](CHANGELOG.md).
