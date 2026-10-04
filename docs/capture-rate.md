# How the v2.7.2 capture-rate fix was found

**The question.** The thirteenth report (75 nodes, zoom 0.10, Electron/Chromium,
GPU disabled) measured 20 fps, a p50 frame of 2.30 ms and a mean of 24.5 ms —
i.e. the *typical* frame was fine and something rare was very expensive: 124 ms of
stalls per second, worst 2273 ms, most of the frame budget outside drawing. The
user's standing rule for this feature is that stand-ins must not cost performance,
**measured** — so the answer had to be a measurement of this tool's own work, not
an explanation of where a frame goes.

## The instrument

A harness scene that is a Vue-nodes page in the shape the frontend renders
(`tests/harness.mjs` + a probe fixture: node root, `node-inner-wrapper`, header,
body, slot dots, a widget grid with real rows, an optional DOM widget), driven
frame by frame with a controlled clock. Per frame it records:

| Counter | Meaning |
| --- | --- |
| `captured` (delta) | pictures actually taken — the expensive thing |
| `vueLayoutReads` | node measurements (`lodVueRootMetrics`), each one a root rect plus every element rect inside it |
| `document._counts.rects` | every `getBoundingClientRect` call on the page |
| host ms/frame | wall time of the frame loop, which is what a user feels |

Five scenarios × 180 frames, before and after the fix.

## What the numbers said (180 frames per scenario)

| Scenario | Before | After |
| --- | --- | --- |
| Quiet (nothing changes) | 0.91–1.36 ms/frame · 0.06 captures/frame | 0.91–1.36 ms/frame · 0.06 captures/frame |
| Page rewrites a widget value every frame | **2.79–6.80 ms/frame · 1.39 captures/frame** | **0.92–1.53 ms/frame · 0.17 captures/frame** |
| 12 nodes × 60 live rows | **15.37 ms/frame · 5.00 captures/frame** | **3.00 ms/frame · 0.20 captures/frame** |

`captures/frame` scaled with **how often a node's content changes**, not with the
node count or the row count — which is what identified the culprit as the capture
*schedule* rather than the capture's cost.

## The mechanism

Read in `web/tracker.js`:

1. A change drops the picture and re-queues the node (`lodSnapPaint` →
   `lodVueChanged` → `lodSnapEnqueue`).
2. A successful capture clears `rec.staleAt` and the node's entry in the settle map.
3. `lodVueSettleLeft`'s ceiling (`LOD_SNAP_SETTLE_MAX_MS`, 900 ms — the rule that
   lets a node which *never* stands still be photographed at all) is **one-shot**:
   `first` is the first change of a burst and is never re-armed.
4. `lodSnapTake` deferred a node only while `lodVueSettleLeft > 0`.

So once the ceiling had passed — a few seconds into a session — **every later ask
bought a full re-capture**, and a page rewriting a widget value produces an ask on
every slice of the idle lane. Two smaller costs rode along: `lodVueShotWait`
forced a *fresh* measurement per ask (paying a node's worth of computed styles and
rects to then refuse the node), and the disk copy was written for every picture of
a churning node.

## The fix

Five edits, all in the lane, described in `CHANGELOG.md` under v2.7.2 and pinned by
three tests that **fail on the pre-fix file**:

1. `LOD_SNAP_PHOTO_MS` (600 ms) + `lodSnapPhotoLeft`, folded into the picker:
   `Math.max(lodVueSettleLeft(node, now), lodSnapPhotoLeft(node, now))`. The node
   **stays queued** and the slice sleeps for the larger window. Rationing at the
   *enqueue* was tried first and reverted — it turned a postponement into a drop,
   which the existing settle test caught.
2. The same floor inside `lodSnapCaptureNode`, where the capture is actually spent.
3. A successful capture deletes the node's settle entry, so every later change gets
   the same 300 ms grace the first one did (before this, a change made after the
   ceiling was photographed on the next slice — mid-render).
4. `lodVueShotWait` reads the cached measurement; the capture still measures fresh.
5. `LOD_SNAP_DISK_MS` (5 s) while a node churns.

## What this measurement does not claim

- It is **host-side JavaScript on a synthetic fixture**, not the user's 4K Electron
  window. The fix removes work (captures, measurements, encodes), so the direction
  is not in doubt; the size on a 75-node page is the user's next report.
- It says nothing about the frontend's own `renderFrame` stalls the report
  attributes through this tool's pass-through wrapper (743 calls, 55.6 s, 4.3 s of
  forced layout). That is not the capture lane and needs its own attribution pass on
  a real page — `plan.md`, K12.
- The churn probe still shows ~31.6 rects/frame in the *no-picture* scenario. That
  is the live boxes' insurance re-measure at their own beat (`LOD_VUE_MEDIA_MS` for
  an unpictured node, `LOD_VUE_MEDIA_MS_IDLE` for one holding a picture, rationed by
  `LOD_VUE_MEDIA_BUDGET`) — one node per frame, not a scene-wide pass, and it
  disappears for a node whose picture is held. It is bounded by design and is the
  first number to look at if the frame cost is still high after the floor.
