# docs/ — the evidence behind the stand-in pathway

`README.md` says what this tool does. `ANALYSIS.md` says what works and what does
not. `memory.md` is the running record. This folder holds the material those three
summarise, in the form it was gathered:

| Document | What it is | Why it is kept |
| --- | --- | --- |
| [`node-snapshots.md`](node-snapshots.md) | A structured reading of **ComfyUI-NodeSnapshots** (`SparknightLLC/ComfyUI-NodeSnapshots`, MIT), the extension this feature learned from: its rasteriser, its offscreen-containment lever, its navigation levers, its own benchmarks, and its issue #1 reports. | It is the closest prior art, it is the source of the credit in `THIRD_PARTY_NOTICES.md`, and one of its levers (`content-visibility`) is deliberately **not** used here — the reasoning has to be written down or it will be re-proposed every few releases. |
| [`nodes-2.0-contract.md`](nodes-2.0-contract.md) | What the Nodes 2.0 (Vue) renderer of `Comfy-Org/ComfyUI_frontend` actually is, per file: components, transform pane, test ids, state overlays, the modules that mirror execution state onto the node object. | Every reader in `web/tracker.js` is written against this, and none of it is a stable public API. When a report says "the stand-in looks wrong", this is the list to re-verify first. |
| [`capture-rate.md`](capture-rate.md) | How the v2.7.2 capture-rate fix was attributed — the harness, the scenarios, the before/after numbers, what the numbers do **not** claim — and the v2.7.3 finding in the same lane (the theme signature reacting to class names and blind to colours). | The user's standing rule is that the stand-ins must not cost performance, *measured*; this is the measurement, including its limits. |

Two conventions in these documents:

- **A file path is a claim about a specific revision.** The Nodes 2.0 contract was
  read from `Comfy-Org/ComfyUI_frontend` `main` and the NodeSnapshots notes from
  `SparknightLLC/ComfyUI-NodeSnapshots` `main`, both on **2026-10-04**. Neither
  project promises these paths across releases; re-verify before relying on one.
- **Anything not read is marked as not read.** Where a document stops at a file
  boundary (`web/index.js`, `web/dom-cache.mjs`), it says so rather than
  extrapolating from the README.
