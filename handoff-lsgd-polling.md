# Stop polling. Push on connect and on widget change. Every ANT / ANTs / ATN / ATNs node.

You own the custom nodes. This is from the tracker that measured them on a real graph. The ask is a behaviour change in those nodes, not a tracker workaround and not a slower timer.

## The rule

No node whose **type, title, class, or file** is prefixed `ANT`, `ANTs`, `ATN`, or `ATNs` — and nothing under `extensions/ANT_NODES/` — may poll the graph to push link data, chain state, widget state, or a derived value.

That includes LSgD links and it includes nodes that do not use LSgD at all. They are all the same pack. A node that is not on an LSgD link is not exempt.

Push data only when one of these happens:

1. A link is connected or disconnected, on this node or on a node in its chain.
2. A widget value changes on this node or on a node in its chain.
3. Once, when the node is created or the workflow is configured / loaded, so a reopened graph is not stale. That one shot is not a timer. After it returns, silence.

Then stop. Do not wake up again until the next one of those events.

A widget change on a **downstream** node counts. The chain head has to hear it because it subscribed when the link was made, and it has to drop that subscription when the link is removed. Rediscovering the chain on a timer is the bug, not a fallback.

If a push would write the same value that is already there, do not write. A serializer that stamps the time, a random id, or "last sweep" into the payload is still a change. Compare, then skip.

## What not to ship

- Do not replace a 16 ms timer with a 250 ms timer and call it done. Four walks a second of a thousand-node chain is still a walk, and it still dirties every node it writes.
- Do not replace the timer with `requestAnimationFrame`. That is ~60 wakes a second. Worse.
- Do not keep the timer and gate it on "the panel is open" or "the user is zoomed in". The graph we measured was sitting there, whole graph on screen, zoom 0.10.
- Do not keep a timer whose only job is to notice that a widget changed. Hook the widget callback (and, if you own the widget, the write). If execution writes a widget, that write is the event. Listen to it. Do not poll for it.
- If some timer must remain, name the reason in a comment next to it, and it must not read layout, must not call `setDirty` / `graph.setDirtyCanvas`, and must not write widgets or link payloads. A 3 s console flush that only prints is fine. A 3 s console flush that recomputes the chain is not.

## The functions the tracker actually named

Line numbers are from the browser stack on that run. If they have moved, find the function. Do not assume the line is still right.

| What the governor recorded | What it was doing | What to do |
| --- | --- | --- |
| `startSweep` in `extensions/ANT_NODES/ant_lsgd_chain_ui.js` ~line 892 | a **250 ms** timer. Four chain sweeps a second, on a graph of 1,041 nodes. This is the LSgD poll. | Delete the sweep. Propagate on connect, disconnect, and widget change of a node in the chain. One shot on configure. |
| `clamp` in `ant_loras_equalizer_curve.js` ~line 7493 | about **36 runs/s** on the same graph. On an earlier run of the same function it was a **16 ms heartbeat that forced 3.0 s of layout**. | Recompute the clamp when the curve widget changes or a linked node's widget changes. Never on a timer. A layout read on a timer is the cost, even if you write nothing. |
| a timer in `ant_merd_console.js` ~line 126 | every **3 s**. Milder. Same pattern. | If it only prints, leave it and say so. If it reads the graph, writes a widget, or asks for a redraw, make it event-driven too. |

Those three are the ones a stack named. The rule is the whole prefix, not these three files. Grep the pack for `setInterval`, `setTimeout` chains, and `requestAnimationFrame` loops that exist to watch links or widgets. Each one gets the same treatment.

The nodes the user pointed at as stuck on the legacy box, on that same graph, were:

- `ANT's Universal Flownatch Scheduler` (chain head)
- `ANT's LoRAs Equalizer Curve`
- `ANT's LoRAs Equalizer`

plus image-load nodes, which are a different problem and not yours to fix here.

## Why a poll is not a private cost

Two separate measurements. Do not mix them into one number.

**Run A — the 1,041-node / 976-link graph, zoom 0.10, upstream NodeSnapshots off, this tracker's own pictures on, 2 GiB budget.** Tracker readout, not a lab estimate:

- fps 19, mean frame 32.6 ms, p95 126.8 ms.
- Since the drawing switch: node drawing 281.5 → 5.67 ms/frame, links 93.8 → 31.2, whole frame 421.6 → 65.7.
- Of the frame that was left: `drawNode` 2.28 ms (7%), `drawConnections` 14.2 ms (44%), everything else 16.1 ms (49%). Node painting is no longer the bill. Timers, layout, and link work are.
- Pictures: 625,156 draws served from bitmaps, 799 captures, 1.7 GB of 2048 MiB held. 206 nodes refused for the session under the old policy (a DOM widget, a function, or a very long string — a serialized chain payload is that third one). 1,311 pictures dropped because the node changed before the picture could be kept. A "375 too large" counter on that run was attempts, not 375 nodes.
- Top stall was a `renderFrame` `setTimeout` at about 20/s. That one is **not** attributed to this pack. Do not go hunting it unless the stack in your build names your file.

**Run B — earlier, same `clamp`, before the snapshot work.** Governor tab, quoted because it is the cleanest single number on that function:

- `clamp @ ant_loras_equalizer_curve.js`: a 16 ms heartbeat, **3.0 s of forced layout** inside it.

**Run C — same size graph, drawing only, governor limits off.** For context, not a claim about your timers:

- At 10% zoom, 1027 of 1041 nodes flattened. Modal frame 44.7 ms, connections about 60% of it. Thinning links, measured: 30.4 → 23.1 ms/frame. Link work is expensive on this graph even after that. A sweep that dirties links or calls `setDirty` feeds that number. We did not trace your sweep into `setDirty`. The timer is what we have. If the sweep does call it, stop.

A 36/s timer on a page whose mean frame is 32.6 ms wakes the main thread about once a frame. A 16 ms timer is a wake every frame plus layout. That is the "madly" in the report.

## Why the pictures die, so you do not "fix" the wrong thing

The tracker photographs a flattened node once, on idle, and reuses the bitmap while a signature matches. The signature includes widget values. A string is hashed by its length and its two ends, so a serialized LSgD payload counts, including a change at the tail. It is re-checked at most every 100 ms. It does not include pan or zoom.

So a poll that writes a widget string, a number, or a boolean changes the node. The picture is dropped. The node falls back to a box, gets queued, gets photographed again, and the next poll drops it again.

As of tracker v2.4.0 that loop is closed on purpose: **three pictures dropped before one of them is drawn, and the node keeps its box for the session**, and the readout names it (`kept changing (3 pictures dropped)`). A fresh picture of a node something rewrites every frame cannot exist, and capturing it forever is work with nothing to show. Slowing the poll to 250 ms does not get under that bar. Not writing is what gets under it.

Stuffing the payload into an object so the signature cannot see it is not a fix. The timer is still on the main thread. The user still cannot trust the picture.

## Done when

On that graph, idle, no widget edits, no new links, for thirty seconds, the tracker Governor tab shows:

- `startSweep` / `ant_lsgd_chain_ui.js`: gone, or 0 runs/s.
- `clamp` / `ant_loras_equalizer_curve.js`: gone, or 0 runs/s.
- the `ant_merd_console.js` timer: gone, or a comment in the readout's source that says it only prints.
- no new `setInterval` / chained `setTimeout` / `rAF` row under `ANT_NODES/` whose runs/s is above zero while idle.

Then change one widget in a chain, once. Exactly one propagation. Then zero again until the next edit or the next connect / disconnect.

And the tracker's snapshot line stops naming `ANT's Universal Flownatch Scheduler`, `ANT's LoRAs Equalizer Curve`, and `ANT's LoRAs Equalizer` as changing. A box that remains for some other reason is fine; a box that says "kept changing" means a write is still happening.

Tracker to re-measure against: `arena/01a0e2a3-ants-comfyui-frontend-performa` at `25256f6` (v2.4.0). Header must read v2.4.0 or the readout will not name the node.
