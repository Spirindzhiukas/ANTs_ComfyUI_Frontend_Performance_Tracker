# ANTs Nasty Bastards Tracker — review of v1, and what v2 changes

Reviewed: `web/tracker.js` (1,468 lines), `__init__.py`, `README.md` at commit
`3458031`. All line numbers below refer to that version of `web/tracker.js`
(`git show 3458031:web/tracker.js`). Everything marked **[test]** has a
regression test in `tests/` whose assertion only holds for the corrected
behaviour — reintroduce the v1 code path and it fails.

The premise of this tool is right, and it is the only tool in the ComfyUI
ecosystem asking the interesting question ("which *frontend* code is eating my
frames?"), but as it stood, three of its headline numbers could be wrong in ways
the user could not see, one of them could permanently hide the extension they
were trying to investigate, and the unit every number was expressed in made the
numbers move when nothing got slower.

---

## 1. Bugs that change the answer

### 1.1 The Timing tab can silently lose an extension for the rest of the session **[test]**
`web/tracker.js:219` — `sweepStaleBuckets()` deletes a bucket once its ring has
been empty for one sweep, i.e. after ~4s of that extension not drawing:

```js
for (const [key, bucket] of hookStats.entries()) {
  trimBucketByCutoff(bucket);
  if (bucket.calls.length === 0) hookStats.delete(key);   // line 219
}
```

But every wrapped hook holds a direct reference to its own bucket object, taken
once at wrap time (`wrapHook`, line 349). After the delete, further calls keep
pushing into that orphaned object and `perExtensionTotals()` (line 111) — which
only ever walks `hookStats` — can never see it again.

Consequence: switch to another ComfyUI tab for four seconds, come back, and that
extension is *gone from the panel* while still drawing. Reported symptom would
be "the timing table is empty even though I'm panning", with no way to fix it
short of a page reload.

**v2:** buckets are created once and never removed while a wrapper references
them; the sweep only trims by wall-clock time. Empty buckets cost 1 KB.

### 1.2 Muting an extension can make it impossible to unmute **[test]**
Same root cause, worse symptom. `wrapHook` returns before recording anything
when the owner is muted (line 353), so a muted extension's bucket goes quiet —
and 4s later the sweep deletes it. `toggleMute` (line 942) only re-renders rows
that exist, so once the row is gone there is nothing left to click. The
`mutedExtensions` set still contains the name, so the hooks stay skipped
indefinitely; only a page reload clears it.

So the bisection workflow this tool exists for could end with an extension
silently disabled and invisible.

**v2:** muted owners always get a row (with an Unmute button), even with zero
live activity, plus a "skipped N calls" counter so you can see the hooks are
still being invoked and are being skipped on purpose.

### 1.3 `attributed` could exceed `frame`, which quietly makes `unattributed` a lie **[test]**
`wrapHook` calls `frameRecordAttributed(dt)` for every hook invocation (line
360), including `onDrawForeground`/`onDrawBackground` calls that happen *outside*
`canvas.draw()` — inside `onExecuted`, a timer, a DOM handler. Meanwhile
`currentFrameAttributedMs` is only reset when a *frame ends* (line 141) and is
never bounded. So:

* hook work performed between frames is folded into whatever frame closes next,
* `attributed` can exceed `frame` outright,
* and `avgUnattributedMs = Math.max(0, avgTotal - avgAttributed)` (line 163) then
  clamps the interesting number to 0 with no warning.

The summary bar's whole purpose — "how much of the frame is *not* explained" —
could read 0.00ms while the real explanation was missing.

**v2:** hook time is attributed to a frame only when a wrapped `draw()` is
currently on the stack (`drawDepth > 0`); everything else goes to a separate
per-owner "off-frame ms" column. All three lanes also come from per-frame
accumulators, so `hooks ≤ drawNode ≤ frame` holds by construction rather than by
clamping.

### 1.4 The unit was "milliseconds per 4 seconds", so numbers moved when nothing got slower **[test]**
Every cell in the Timing/Nodes tabs is a sum over a 4s window (`ROLLING_WINDOW_MS`,
line 63; `bucketRecentTotalMs`, line 99). That number is an integer multiple of
the redraw rate: pan faster and every row's cost "grows" by 4x while the *cost
per frame* is unchanged. It also cannot be compared to a 16.6ms budget, or
between two people, or before/after a fix on a graph you panned differently.

**v2:** every cost is shown per drawn frame (`ms/frame`), as a share of the frame
(`% of frame`), per call (`ms/call`), and per frame (`calls/frame`). The window
sums still exist — in the detail row and the report — but they are never the
headline. Rate metrics (`fps`, `requests/s`) are wall-clock, because that is what
they are.

### 1.5 `fps` was wrong or 0 in exactly the configurations the Testing tab recommends **[test]**
`fps = n / (last.t - first.t)` over a 4s window (line 165) — samples divided by
span, rather than *intervals* (n-1) divided by span. That is a rounding error at
60 fps and a two-fold overestimate at a 2–3 fps cap; at a 5s or 10s cap the window
usually contains a single sample, so `fps` read 0.0. The failure lands precisely
where the README tells you to check it: "The `fps` number in the summary bar
should drop to roughly match your pick" (README lines 13–14).

**v2:** frame statistics use a 10s window that automatically widens to 30s when
it holds fewer than 4 frames, and says which window it used. With 1 fps over 20s
you get `fps 1.0`; with a 5s cap you get `0.2` and a visible "30s window" label.

### 1.6 The panel rebuilt itself from `innerHTML` every 500ms **[test]**
`refreshTimer = setInterval(() => renderBody(true), 500)` (line 934) and every
tab ended in `body.innerHTML = html` (lines 1040, 1118, 1149, 1159, 1169, 1240).
Three consequences, all of them user-visible:

* **Scroll position resets every half second.** With 200 extensions or node types
  you cannot read past the first screen of the list.
* **Rows reorder under the pointer.** Timing and Nodes tables are sorted by live
  window cost (lines 978, 329), so the row you are aiming at moves between
  mousedown and mouseup.
* **Element identity is thrown away.** Any transient UI state — a focused input,
  a selected row, a hovered tooltip — dies twice a second. Testing is exempted
  while it is the active tab (the comment at line 1413), which is the right
  instinct; the other six tabs are not.

**v2:** keyed rows updated in place (`RowSet`). Scroll, expansion state and element
identity survive refreshes; row order freezes while the pointer is inside the
list and re-applies when it leaves; the Testing tab's controls are built once.

### 1.7 The redraw cap dropped frames permanently **[test]**
`drawThrottleMs` skipped a redraw outright (`return undefined`) and never
rescheduled it. Consequence: the canvas can keep displaying stale pixels until an
unrelated event dirties it — the opposite of the "genuine, low-risk mitigation
for huge graphs" the README advertises.

**v2:** a capped redraw schedules exactly one trailing redraw, so the cap delays
instead of dropping. Counters for both are in the Testing tab.

### 1.8 The canvas patch was attempted exactly once **[test]**
`patchCanvasDrawOnce()` (line 482) is called from `setup()` and returns early if
`app.canvas` is not there yet — with no retry. On a frontend where the canvas
appears later (or is not a classic `LGraphCanvas`), frame totals, fps,
`unattributed` and the whole Nodes tab are silently unavailable for the session,
with only a console warning that most users never open.

**v2:** a failed patch stays unpatched and retries for ~20s, then reports the
degradation in the panel itself (not just the console) and states which numbers
are still valid.

### 1.9 The "shared tick" detector could not name a culprit, and could be fooled
`detectSharedTick`/`bestSharedUnit` (lines 257–300) inferred a graph-wide
heartbeat from the fact that many node types had call counts that were multiples
of some value. It tests *every observed count* as a candidate unit, including
per-frame counts, and keeps the candidate explaining the most rows — so
"everything is a multiple of 1 repaint per frame, because everything is being
painted every frame" is excluded only by the `candidate >= frames * 0.8`
heuristic (line 288). And even when it fires it can only say "something is
ticking"; the investigation that follows is still manual.

**v2:** the guesswork is replaced by measurement. Every redraw *request* funnels
through `canvas.setDirty()`, so that is wrapped (exact rate) and its call stack is
sampled ~20/s to produce a ranked caller table — file, function, line, and
extension pack. Long Animation Frames add the invoker
(`TimerHandler:setInterval`) and the blocking time per script. "Something ticks
every 100ms" becomes "`pollStatus` in Pack X, invoked by a timer, 20x/second,
190ms of blocking per second".

### 1.10 Load-tab numbers were arithmetically impossible **[test]**
Line 562: `entry.ms += e.duration || 0` sums the durations of *concurrent*
fetches, so a pack of 10 files fetched in parallel could report a "load time"
several times longer than the page load itself.

**v2:** reports a span (first request start → last response end) plus file count,
slowest file and cache-served count, and says why.

---

## 2. Blind spots that produced most of the "unattributed" mystery

### 2.1 Per-instance hooks were invisible **[test]**
Only hooks reached through `beforeRegisterNodeDef` were wrapped. A node type that
assigns its own `this.onDrawForeground = function () { ... }` inside
`onNodeCreated` — a pattern used for image previews and other per-instance canvas
work, and one that never touches the prototype — is invisible to that mechanism,
as is any override installed after registration. Those costs could only ever
appear as anonymous "unattributed" time.

**v2:** the node is inspected as it is drawn (`maybeWrapInstanceHooks`), and an
instance hook is adopted on the fly, labelled `(unattributed) PreviewImage ·
instance hook` (or with its extension name when that can be inferred from which
extension instrumented the node type).

### 2.2 Hooks that predate this tool were invisible **[test]**
Anything already on a `LGraphNode` prototype when the tracker loaded — the
normal case for anything this folder's load order did not beat — was skipped
forever.

**v2:** `scanRegisteredTypes()` adopts them against the node type they belong to,
so at worst the cost is named by *node type* instead of being anonymous.

### 2.3 `onBounding`/`onDrawBackground` called outside a frame polluted per-extension cost **[test]**
Covered by 1.3; worth calling out because these two are also called from
hit-testing and hover paths, not only from `draw()`.

### 2.4 Nothing measured non-canvas cost at all
There was no observation of long tasks or animation frames, so the class of
problem that most often causes "my UI is janky and it isn't the graph" — a
heartbeat, a polling loop, layout thrash, a big GC — had no lane in the panel.

**v2:** a Stalls tab, sourced from Long Animation Frames (Chrome 123+, with
script/function/invoker and forced-layout time) with a `longtask` fallback, and
explicit "this browser cannot report it" text when neither exists.

### 2.5 The GPU tab gave up on the one number it could have had
The README (and the tab) is right that per-extension VRAM is impossible from page
JavaScript. But `GET /system_stats` is served by every ComfyUI to the browser and
contains per-device VRAM totals/free plus torch's own accounting, and nvidia-smi
can be surfaced by the backend. The tab instead ended with "run a script
alongside ComfyUI and eyeball it".

**v2:** the GPU tab reads `/system_stats` — headroom from `vram_total`/
`vram_free`, torch's pool read the way ComfyUI defines it (`torch_vram_total` is
what torch has *reserved*, `torch_vram_free` the unused part of it, so in-use is
total − free), and the remainder (`used − torch in use`) labelled "not torch"
rather than blamed on fragmentation — plus an optional new backend route,
`GET /ants_tracker/gpu`, which shells out to nvidia-smi with a 2s cache and
reports "not available, because X" when there is no NVIDIA tooling.
Per-extension VRAM attribution is still documented as impossible rather than
faked.

---

## 3. Measurement-design problems (not bugs, but they limit usefulness)

1. **No share-of-frame or percentile frame time.** A mean frame time hides the
   hitching that makes a graph feel bad; nothing in v1 computed p95/p99. v2 shows
   mean/p50/p95/p99 and flags the tail.
2. **No reference for "is this a lot?"** A row reading `231.0ms` gave no way to
   judge it against the 16.6ms budget, and the colour thresholds were absolute
   window sums — hot above 200ms per 4s window, warm above 50ms (lines 1014,
   1080). So panning faster turned the same per-frame cost from cold to hot:
   `50ms / 4s` is only 0.21ms per frame at 60 fps, i.e. 1.3% of a frame, and the
   faster you pan the more the identical hook is penalised. v2 gives `% of frame`
   and colours rows against the frame budget (warm at 5%, hot at 15%), which does
   not move when cadence does.
3. **Mute was the only A/B method, and hand measurement is not comparable.** Fast
   cap vs slow cap changed how long you naturally waited; drag speed changed the
   4s sums by 4x. v2's scripted pan benchmark runs the same motion for the same
   number of seconds and reports ms/frame, p95 and fps over exactly that span,
   with A/B slots that record which mutes were active (and say so when A and B
   differ).
4. **The unattributed bucket had no internal structure.** "Unattributed" mixed
   LiteGraph's own chrome, embedded preview bitmaps, and canvas-level drawing.
   v2 splits the frame into `drawNode` (itself split into wrapped hooks vs
   LiteGraph chrome) / `drawConnections` / everything else, which is usually
   enough to know *where* to look before opening DevTools.
5. **No way to distinguish "nothing is happening" from "nothing is instrumented".**
   v1's empty state did explain the hook count, but not the pre-existing/instance
   cases, and not the paused case. v2's empty states enumerate what was wrapped,
   what was adopted, whether sampling is paused, and which tab to look at instead.
6. **The tool's own cost was invisible.** Nothing checked whether the profiler was
   the reason the graph got slower. v2 reports wrapped-hook count, bucket memory,
   and its own panel/bookkeeping cost per second, and ring buffers are typed
   arrays written in place (v1 pushed an object per hook call and `shift()`ed
   arrays, which is O(n) per call and allocates continuously).
7. **Sampling could not be paused**, so a jumpy table could not be read. v2 has
   Pause (freezes the snapshot without touching rendering) and Reset (clears
   samples, keeps mutes and settings).
8. **Nothing was copyable in one click** except the whole report. v2 keeps the
   one-click text report, now with environment, budget, invalidation callers,
   stalls, load, memory, benchmark and self-cost, and exposes the same data on
   `window.__antsTracker`.

---

## 4. What still cannot be measured (unchanged, and now stated in the panel)

* Costs inside a widget's own `draw()`, a Vue component (Nodes 2.0-style), or a
  canvas method this tool does not wrap are not attributed *by name*; they land
  in "everything else" and, if they block, in the Stalls tab.
* Per-extension GPU memory: not obtainable in any browser. Never fake it.
* Firefox exposes neither `performance.memory` nor long tasks; those tabs are
  empty there by design and say so.
* Redraw callers are sampled (~20/s), so a rare burst can be missed; the *rate*
  is exact.
* Muting changes behaviour, so a muted/unmuted delta is an upper bound, not a
  price list.
* Frame cost measured here is JS/canvas cost; compositor and GPU time are not
  visible from the page.

---

## 5. How this was verified

`node tests/run-tests.mjs` (36 tests) loads `web/tracker.js` into a fake browser
and a fake ComfyUI/LiteGraph with a controllable clock (no dependencies, no
jsdom), and asserts the numbers, not just the code paths: hook attribution per
frame, budget additivity, off-frame separation, mute semantics, cap deferral,
loose-cap fps, aging-out, instance/pre-existing hook adoption, stall and
invalidation attribution, load spans, panel row identity/scroll/order behaviour,
and the A/B benchmark. The sections marked **[test]** are the ones with a
dedicated regression test; reintroducing the v1 code path fails it. `python3 tests/test_init.py` covers the backend route's
parsing and its graceful behaviour when nvidia-smi is missing.
