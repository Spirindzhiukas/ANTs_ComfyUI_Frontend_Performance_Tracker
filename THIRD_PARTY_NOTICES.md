# Third-party notices

This project is released under the MIT licence (see [`LICENSE`](LICENSE)).
It was built on ideas from the projects below, and one of them ships code
whose notice has to travel with any substantial portion of it. Those notices
are reproduced verbatim here. The README's **Credits** section says what was
taken from each, what was changed, and what was deliberately left out.

## ComfyUI-NodeSnapshots

The node stand-in engine (a captured bitmap replacing a flat stand-in, the
own-attribution capture, the slow-capture cutoff and the named refusal
reasons) is this project's re-implementation of the idea in
[ComfyUI-NodeSnapshots](https://github.com/SparknightLLC/ComfyUI-NodeSnapshots),
on this file's own seams, budget and idle lane.

Its licence, as shipped at the upstream repository root:

```
MIT License

Copyright (c) 2026 Sparknight LLC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Upstream also ships `PHOSPHOR-LICENSE.txt` for a camera icon used by its own
UI. No icon or other asset from that repository is used here, so that notice
is not carried.

## ComfyUI-DisableBrowserLogs

[ComfyUI-DisableBrowserLogs](https://github.com/SparknightLLC/ComfyUI-DisableBrowserLogs)
is credited as the source of the *idea* for the console-attribution mode
described in `plan.md`, Track L — count and attribute console traffic per
owner before offering to mute it, rather than muting permanently.

No code was copied from it. The upstream repository did not carry a licence
file at its root when this notice was written, so nothing here depends on it
either: the mode is not built yet, and the panel's own diagnostics never go
through a silenced console.

## ComfyUI

[ComfyUI](https://github.com/comfyanonymous/ComfyUI) (comfyanonymous and
contributors, GPL-3.0) supplies the extension API this tool is built on —
`app.registerExtension`, the canvas draw hooks, `/scripts/app.js`,
`/system_stats` and the `/extensions/` layout. No ComfyUI source code is
copied into this repository; the extension talks to that API at runtime.
ComfyUI's own console output is what a log-attribution mode would measure.
