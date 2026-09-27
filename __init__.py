"""
ANTs Nasty Bastards Tracker
============================

A frontend-side profiler for ComfyUI. It answers the question the DevTools
performance panel makes you work for: "which extension's JavaScript is actually
costing me frames while I pan a heavy graph, and what is eating main-thread time
that no draw hook owns?"

How it works (see web/tracker.js for the real logic):
  1. It patches `app.registerExtension` as early as possible (this folder is
     prefixed 0000_ so it loads before other custom nodes' web directories,
     alphabetically), then wraps the draw-related callbacks every other
     extension attaches to node types — onDrawForeground, onDrawBackground,
     onDrawCollapsed, onBounding — tagged with that extension's name.
  2. It also adopts draw hooks that would otherwise be invisible: hooks that
     already existed on a node prototype before this tool loaded, and
     per-instance hooks (`this.onDrawForeground = ...`, which is how ComfyUI's
     own core nodes draw). Those are the costs that used to land in a nameless
     "unattributed" bucket.
  3. It wraps the canvas's own draw()/drawNode()/drawConnections() so every
     number can be expressed per drawn frame ("ms/frame", "% of the frame")
     instead of as a raw sum over an arbitrary window, and wraps
     canvas.setDirty() so redraw *requests* can be attributed to a caller by
     sampled stack, which is what finds a runaway setInterval heartbeat.
  4. It observes long animation frames (Chrome 123+) / long tasks, so the cost
     that is not canvas drawing at all — timers, layout thrash, GC — gets its
     own tab with a named script and invoker.
  5. A floating panel shows all of it live with per-owner mute, a scripted pan
     benchmark for comparable A/B runs, and a plain-text snapshot for bug
     reports.

The Python side does almost nothing on purpose: it serves the frontend and adds
one optional read-only route (/ants_tracker/gpu) that shells out to nvidia-smi,
because GPU memory is the one thing page JavaScript genuinely cannot read. If
nvidia-smi is missing, the route says so and the panel falls back to ComfyUI's
own /system_stats.

Safe to drop into any workflow: no inputs, no outputs, no execution, no
dependencies, no writes to disk.
"""

WEB_DIRECTORY = "web"

# The GPU probe is cached for this long. The panel polls it at most every 2.5s
# while its GPU tab is open, and spawning nvidia-smi is not free.
GPU_CACHE_SECONDS = 2.0

_NVIDIA_SMI_TIMEOUT = 5

_gpu_cache = {"at": 0.0, "payload": None}

try:  # pragma: no cover - only importable inside a running ComfyUI
    from server import PromptServer
except Exception:  # pragma: no cover
    PromptServer = None


def parse_nvidia_smi(gpu_csv, proc_csv=None):
    """
    Turn nvidia-smi CSV output into the JSON shape the panel expects.

    Kept as a pure function (no subprocess, no framework) so it can be tested
    without a GPU or a running ComfyUI.
    """
    gpus = []
    for line in (gpu_csv or "").splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 3 or not parts[0]:
            continue
        gpus.append(
            {
                "index": _number(parts[0]),
                "name": parts[1] if len(parts) > 1 else None,
                "utilization_gpu": _number(parts[2]) if len(parts) > 2 else None,
                "memory_used": _number(parts[3]) if len(parts) > 3 else None,
                "memory_total": _number(parts[4]) if len(parts) > 4 else None,
                "temperature_gpu": _number(parts[5]) if len(parts) > 5 else None,
                "power_draw": _number(parts[6]) if len(parts) > 6 else None,
                "power_limit": _number(parts[7]) if len(parts) > 7 else None,
            }
        )
    processes = []
    for line in (proc_csv or "").splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 3 or not parts[0]:
            continue
        processes.append(
            {
                "pid": _number(parts[0]),
                "name": _short_process_name(parts[1]),
                "used_memory": _number(parts[2]),
            }
        )
    if not gpus:
        return {"available": False, "reason": "nvidia-smi returned no GPUs (no NVIDIA device visible to this process)"}
    return {"available": True, "gpus": gpus, "processes": processes}


def _number(text):
    """nvidia-smi prints 'N/A' or '[N/A]' for fields it cannot read."""
    if text is None:
        return None
    cleaned = str(text).strip().strip("[]")
    if not cleaned or cleaned.upper().startswith("N/A") or cleaned.lower() in ("not supported", "[not supported]"):
        return None
    try:
        value = float(cleaned)
    except ValueError:
        return None
    return int(value) if value.is_integer() else value


def _short_process_name(path):
    name = str(path).replace("\\", "/").split("/")[-1]
    return name or None


def query_nvidia_smi():
    """
    Run nvidia-smi and return the parsed payload. Never raises: an absent binary,
    a driver hiccup or a timeout all become {'available': False, 'reason': ...},
    which the panel renders as an explanation rather than an error.
    """
    import shutil
    import subprocess

    exe = shutil.which("nvidia-smi")
    if not exe:
        return {
            "available": False,
            "reason": "nvidia-smi is not on this machine's PATH (AMD/Intel/Apple GPU, or no NVIDIA driver tools installed)",
        }
    try:
        gpu = subprocess.run(
            [
                exe,
                "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=_NVIDIA_SMI_TIMEOUT,
        )
        if gpu.returncode != 0:
            return {"available": False, "reason": f"nvidia-smi exited {gpu.returncode}: {(gpu.stderr or '').strip()[:200]}"}
        try:
            proc = subprocess.run(
                [exe, "--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"],
                capture_output=True,
                text=True,
                timeout=_NVIDIA_SMI_TIMEOUT,
            )
            proc_csv = proc.stdout if proc.returncode == 0 else ""
        except Exception:
            proc_csv = ""
        return parse_nvidia_smi(gpu.stdout, proc_csv)
    except subprocess.TimeoutExpired:
        return {"available": False, "reason": f"nvidia-smi did not answer within {_NVIDIA_SMI_TIMEOUT}s"}
    except Exception as exc:  # pragma: no cover - defensive
        return {"available": False, "reason": f"nvidia-smi could not be run: {exc}"}


def _cached_gpu_payload():
    import time

    now = time.monotonic()
    if _gpu_cache["payload"] is not None and (now - _gpu_cache["at"]) < GPU_CACHE_SECONDS:
        return _gpu_cache["payload"]
    payload = query_nvidia_smi()
    _gpu_cache["payload"] = payload
    _gpu_cache["at"] = now
    return payload


def register_routes():
    """
    Register the optional GPU route. Deliberately best-effort: if this ComfyUI
    build has no route registry (or the import failed), the tracker still works
    and the panel simply says the side-channel is unavailable.
    """
    if PromptServer is None or not getattr(PromptServer, "instance", None):
        return False
    routes = getattr(PromptServer.instance, "routes", None)
    if routes is None:
        return False
    try:
        from aiohttp import web
    except Exception:  # pragma: no cover - aiohttp ships with ComfyUI
        return False

    try:

        @routes.get("/ants_tracker/gpu")
        async def ants_tracker_gpu(request):  # noqa: ARG001 - aiohttp signature
            import asyncio

            loop = asyncio.get_event_loop()
            payload = await loop.run_in_executor(None, _cached_gpu_payload)
            return web.json_response(payload)

    except Exception:  # pragma: no cover - a route may already exist on reload
        return False
    return True


register_routes()


class ANTsNastyBastardsTracker:
    """
    Dummy node. Its only job is to carry a widget button (added on the JS side)
    that opens the tracker panel. The tracker itself runs continuously from page
    load whether or not this node exists in your graph.
    """

    CATEGORY = "ANTs/debug"
    FUNCTION = "noop"
    RETURN_TYPES = ()
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    def noop(self):
        return ()


NODE_CLASS_MAPPINGS = {
    "ANTsNastyBastardsTracker": ANTsNastyBastardsTracker,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ANTsNastyBastardsTracker": "🔧 ANTs Nasty Bastards Tracker",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
