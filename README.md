# ANTs Nasty Bastards Tracker

A frontend-side profiler for ComfyUI. Answers "which extension is
actually costing me FPS while panning this graph?" without needing
Chrome DevTools open, and without restarting ComfyUI to bisect.

## Testing tab

Two opt-in overrides, both off by default, neither persisting across a
reload:

- **Canvas redraw rate cap** — skips any real redraw arriving sooner
  than the chosen interval, regardless of what's asking for it. The
  `fps` number in the summary bar should drop to roughly match your
  pick; that's it working, not a bug. This doubles as a genuine, low-risk
  mitigation for huge graphs, not just a diagnostic — if a workflow
  feels fine capped at 15fps, that's real, immediate relief with zero
  node-code changes.
- **Synthetic forced-tick generator** — forces an extra full redraw at
  a fixed, known interval, independent of everything else, so you have
  a controlled reference point to compare against whatever organic tick
  the Nodes tab's shared-tick detector finds. It shares the same redraw
  path as the cap above, so an active cap will throttle these forced
  ticks too — set the cap to Off first to measure an uncapped
  synthetic tick's real cost.

## Hook-wrap counter

The Timing tab's empty state now says how many (extension, hook) pairs
were ever actually wrapped this session. `0 hooks wrapped` means no
extension in this session overrides `onDrawForeground` and friends
directly — check the Nodes tab instead. A nonzero count with nothing
firing recently means something that used to draw via a hook may have
been refactored to draw a different way (a custom widget's own
`draw()`, or a centralized heartbeat) — this resolves that ambiguity
permanently instead of requiring a fresh investigation each time.

## Known fixed bug: stale data across tab/graph switches

Earlier versions kept accumulating stats per extension/node-type
forever once a type stopped being drawn (e.g. you switched to a
different ComfyUI tab) — a bucket's rolling window only trimmed on its
own next write, so a type that goes idle would sit frozen at its old
numbers indefinitely instead of aging out after 4 seconds like
everything else. This is fixed two ways: a periodic sweep (every
second) trims every bucket by wall-clock time regardless of activity,
and an `afterConfigureGraph` hook clears everything instantly on an
actual workflow load. If you still see a node type that clearly isn't
in your current graph lingering for more than a few seconds after
switching, that's worth reporting.

## Copy button

The 📋 **Copy** button in the panel header dumps a full plain-text
snapshot of all tabs (Timing, Nodes, Load, Memory, the shared-tick
banner if active) to your clipboard in one go — meant for pasting into
a chat or bug report instead of a screenshot, which is both faster for
you and cheaper in tokens on the other end.

## Install

Drop this whole folder into `ComfyUI/custom_nodes/` so it sits at:

```
ComfyUI/custom_nodes/0000_ANTs_nasty_bastards_tracker/
    __init__.py
    web/tracker.js
```

The `0000_` prefix is deliberate — it makes this load before other
custom nodes' web directories (alphabetically), which it needs to do
in order to catch every other extension's `registerExtension` call.
Don't rename it unless you also rename it to something that still
sorts first.

Restart ComfyUI. No dependencies, nothing to `pip install`.

## Use

The tracker starts recording automatically the moment the page loads
— you don't need to place any node for it to work. Two ways to open
the panel:

1. A small 🔧 button appears pinned to the screen at all times. A
   quick click opens/closes the panel. Press and hold it for a moment,
   then drag — it switches into move mode instead of clicking, and
   remembers wherever you drop it (via `localStorage`), even across
   page reloads. Handy since its default spot can collide with
   ComfyUI's own minimap/queue UI depending on your layout; drag it
   up near the top bar or wherever's actually clear on your screen.
2. Or drag in the **"ANTs Nasty Bastards Tracker"** node (category
   `ANTs/debug`) and click its **Open Tracker** button. The node does
   nothing else — no inputs, no outputs, never executes.

### Timing tab

Pan/zoom your heavy graph for a few seconds with the panel open. Each
row is one *other* extension, sorted by how much draw time it's
burned in the last few seconds. Red = hot, orange = warm. Hit **Mute**
on a suspect to fully skip its draw hooks live — watch the fps number
in the summary bar change in real time. That's your bisection tool;
no folder-shuffling or restarts needed.

**Unattributed** (in the summary bar) is canvas draw time that isn't
accounted for by any tracked extension. If that number is large, some
node pack is patching LiteGraph's canvas/node prototypes directly
instead of going through the sanctioned `beforeRegisterNodeDef` hook
— this tool can tell you *that it's happening* but not *who's doing
it* without a manual DevTools trace, since it never went through the
door this tool is watching.

### Nodes tab

A second, independent measurement lane from the Timing tab. This times
LiteGraph's own `drawNode()` call in full, per node *type* — borders,
title bar, slots, widgets, embedded preview bitmaps, everything —
which **includes** whatever the Timing tab already reports for that
node's own extension hooks as a subset. Don't add the two tabs
together; they answer different questions.

In practice, this is usually where most of "unattributed" time in the
summary bar actually lives. It's rarely a rogue extension — it's
LiteGraph's own per-node chrome-drawing cost, multiplied by however
many nodes of that type are visible. A node type with an image-preview
widget sitting at the top of this list is worth checking first:
redrawing large embedded bitmaps every frame while panning is
expensive and has nothing to do with any custom node's JS.

### Load tab

Startup/page-load cost per extension pack (from the browser's own
Resource Timing data) — separate from runtime draw cost. A pack can
be heavy to load but cheap to run, or the other way around.

### Memory tab

JS heap snapshot (Chromium only — Firefox doesn't expose
`performance.memory` to page JS at all, by design). No per-extension
breakdown is possible here; use "Set baseline" + mute a suspect +
compare the delta to bisect a memory hog manually.

### GPU / VRAM tab

Deliberately honest: this is not obtainable from page JavaScript in
any browser, full stop — it's a sandbox boundary, not a missing
feature. The tab explains the closest workaround (an external
`nvidia-smi` poll run alongside ComfyUI, eyeballed against a
mute/unmute test's timestamp) rather than faking a number.

## What this can't catch

Only draw-ish hooks reachable through `beforeRegisterNodeDef`
(`onDrawForeground`, `onDrawBackground`, `onDrawCollapsed`,
`onBounding`) are attributed by name. An extension that:

- patches `LGraphCanvas.prototype` / `LGraphNode.prototype` directly
  at top-level script load, or
- does its expensive work somewhere other than these four hooks
  (e.g. inside `onExecuted`, a `setInterval`, or a Vue component for
  a Nodes-2.0-style widget)

...won't show up by name. Its cost will still show up as a gap
between "frame" and "attributed" in the summary bar, which at least
tells you there's something to go hunting for with a full DevTools
Performance trace.

## Compatibility note

This assumes the classic LiteGraph canvas frontend
(`app.canvas.constructor.prototype.draw` and `.drawNode`,
`nodeType.prototype.onDraw*`). If a future ComfyUI frontend version
changes these internals, the browser console will log an
`[ANTs Tracker]` warning explaining what it couldn't find, rather than
failing silently. Each patch point degrades independently: losing
`draw` costs you the frame-total/unattributed numbers, losing
`drawNode` costs you the Nodes tab, and per-extension hook timing
(Timing tab) works regardless of either.
