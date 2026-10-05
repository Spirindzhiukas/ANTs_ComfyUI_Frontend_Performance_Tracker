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
  5. The detached optimizer window is the sole settings and metrics UI, with
     per-owner mute, a scripted pan benchmark for comparable A/B runs, and a
     plain-text snapshot for bug reports. In-page, only the power/gear pill and
     its copy on the headless node remain.

The Python side serves the frontend, adds one optional read-only route
(/ants_tracker/gpu) that shells out to nvidia-smi, and — because the page cannot
write a folder — stores node pictures under ComfyUI's temp directory when the
frontend asks. That write is the disk cache for the pictures. Nothing else is
written to disk. The detached window (/ants_optimizer/window) talks to the page
through /ants_optimizer/ui, which is memory only: a revision and an origin, so a
change made in the window and a change made on the page are the same settings,
and neither side is the master. If nvidia-smi is missing, the GPU route says so
and the detached window falls back to ComfyUI's own /system_stats.

Safe to drop into any workflow: no inputs, no outputs, no execution, no
dependencies.
"""

import copy
import os
import threading
import time

WEB_DIRECTORY = "web"

# Node pictures, keyed by node id and a signature of what the node draws. The
# page cannot write this folder; it asks these helpers. The directory is ComfyUI's
# own temp folder when that can be found, otherwise temp/ next to custom_nodes.
THUMB_DIR_NAME = "ANTs_Frontend_Optimizer_THUMBNAILS"
THUMB_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
THUMB_MAX_BYTES = 8 * 1024 * 1024

_thumb_root_override = None

# The GPU probe is cached for this long. The detached GPU tab polls it only
# while active, and spawning nvidia-smi is not free.
GPU_CACHE_SECONDS = 2.0

_NVIDIA_SMI_TIMEOUT = 5

_gpu_cache = {"at": 0.0, "payload": None}

try:  # pragma: no cover - only importable inside a running ComfyUI
    from server import PromptServer
except Exception:  # pragma: no cover
    PromptServer = None


def parse_nvidia_smi(gpu_csv, proc_csv=None):
    """
    Turn nvidia-smi CSV output into the JSON shape the detached window expects.

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
    which the detached GPU tab renders as an explanation rather than an error.
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


def set_thumb_root(path):
    """Test seam. None restores autodetection."""
    global _thumb_root_override
    _thumb_root_override = path


def safe_token(value, limit=80):
    """A filename token. Anything else is refused, not escaped into a path."""
    raw = str(value or "")
    out = []
    for ch in raw:
        if ch.isalnum() or ch in "._-":
            out.append(ch)
        else:
            out.append("_")
    token = "".join(out).strip("._")
    if token in ("", ".", ".."):
        return ""
    return token[:limit]


def comfy_temp_dir():
    """ComfyUI's temp folder, or temp/ next to custom_nodes if that import is missing."""
    folder_paths = None
    try:
        import folder_paths as found
        folder_paths = found
    except Exception:
        folder_paths = None
    if folder_paths is not None:
        for name in ("get_temp_directory", "get_temp_dir"):
            fn = getattr(folder_paths, name, None)
            if callable(fn):
                try:
                    found = fn()
                except Exception:
                    found = None
                if found:
                    return str(found)
        for attr in ("temp_directory", "temp_dir"):
            found = getattr(folder_paths, attr, None)
            if found:
                return str(found)
    here = os.path.dirname(os.path.abspath(__file__))
    # custom_nodes/<this pack>/__init__.py → the ComfyUI root is two levels up.
    root = os.path.dirname(os.path.dirname(here))
    return os.path.join(root, "temp")


def thumb_root():
    if _thumb_root_override:
        os.makedirs(_thumb_root_override, exist_ok=True)
        return _thumb_root_override
    path = os.path.join(comfy_temp_dir(), THUMB_DIR_NAME)
    os.makedirs(path, exist_ok=True)
    return path


def image_kind(data):
    if not data or len(data) < 12:
        return ""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "webp"
    return ""


def write_thumb(node_id, sig, data):
    """Replace every stored picture for this node id with this one. A change wins."""
    ident = safe_token(node_id)
    signature = safe_token(sig)
    if not ident or not signature:
        raise ValueError("bad id")
    if not data or len(data) > THUMB_MAX_BYTES:
        raise ValueError("bad body")
    if not image_kind(data):
        raise ValueError("not an image")
    root = thumb_root()
    prefix = ident + "__"
    for name in list(os.listdir(root)):
        if name.startswith(prefix) and name.endswith((".png", ".webp", ".tmp")):
            try:
                os.remove(os.path.join(root, name))
            except OSError:
                pass
    ext = "webp" if image_kind(data) == "webp" else "png"
    final = os.path.join(root, "%s__%s.%s" % (ident, signature, ext))
    tmp = final + ".tmp"
    with open(tmp, "wb") as handle:
        handle.write(data)
    os.replace(tmp, final)
    return final


def read_thumb(node_id, sig):
    """The file for this id and signature, or None. A different signature is a miss."""
    ident = safe_token(node_id)
    signature = safe_token(sig)
    if not ident or not signature:
        return None
    root = thumb_root()
    for ext in ("png", "webp"):
        path = os.path.join(root, "%s__%s.%s" % (ident, signature, ext))
        if os.path.isfile(path):
            return path
    return None


def delete_thumbs(node_id):
    ident = safe_token(node_id)
    if not ident:
        return 0
    root = thumb_root()
    prefix = ident + "__"
    removed = 0
    for name in list(os.listdir(root)):
        if not name.startswith(prefix):
            continue
        try:
            os.remove(os.path.join(root, name))
            removed += 1
        except OSError:
            pass
    return removed


def sweep_thumbs(now=None, max_age=THUMB_MAX_AGE_SECONDS):
    """Delete thumbnail files older than a week. The weekly cleanup."""
    root = thumb_root()
    moment = time.time() if now is None else float(now)
    removed = 0
    for name in list(os.listdir(root)):
        if name.startswith("."):
            continue
        path = os.path.join(root, name)
        if not os.path.isfile(path):
            continue
        try:
            age = moment - os.path.getmtime(path)
        except OSError:
            continue
        if age > max_age:
            try:
                os.remove(path)
                removed += 1
            except OSError:
                pass
    return removed


def thumb_info():
    root = thumb_root()
    count = 0
    try:
        count = sum(
            1
            for name in os.listdir(root)
            if not name.startswith(".") and os.path.isfile(os.path.join(root, name))
        )
    except OSError:
        count = 0
    return {"dir": root, "count": count, "maxAgeDays": 7}


# The separate window and the ComfyUI page share this. It is not written to
# disk. A settings change bumps rev and records who made it, so each side can
# ignore its own echo. Telemetry does not bump rev: a live number is not a
# change of settings. heard is set only when the window asks, so the page can
# stop posting when nobody is looking.
_ui_lock = threading.Lock()
_UI_EMPTY = {
    "rev": 0,
    "origin": "",
    "settings": None,
    "telemetry": None,
    "limits": None,
    "command": "",
    "command_label": "",
    "command_data": None,
    "command_rev": 0,
    "heard": 0.0,
}
_ui = dict(_UI_EMPTY)


def ui_reset():
    with _ui_lock:
        _ui.clear()
        _ui.update(_UI_EMPTY)
        _ui["settings"] = None
        _ui["telemetry"] = None
        _ui["limits"] = None


def _ui_copy(now):
    heard = _ui["heard"]
    return {
        "ok": True,
        "rev": _ui["rev"],
        "origin": _ui["origin"],
        "settings": _ui["settings"],
        "telemetry": _ui["telemetry"],
        "limits": _ui["limits"],
        "command": _ui["command"],
        "commandLabel": _ui["command_label"],
        "commandData": _ui["command_data"],
        "commandRev": _ui["command_rev"],
        "heardAge": None if not heard else now - heard,
    }


def ui_snapshot(hear=False):
    with _ui_lock:
        now = time.time()
        if hear:
            _ui["heard"] = now
        return _ui_copy(now)


def ui_update(body, who=""):
    if not isinstance(body, dict):
        raise ValueError("body")
    with _ui_lock:
        now = time.time()
        origin = str(body.get("origin") or who or "")
        if isinstance(body.get("settings"), dict):
            _ui["rev"] += 1
            _ui["origin"] = origin
            _ui["settings"] = copy.deepcopy(body["settings"])
        if "telemetry" in body:
            _ui["telemetry"] = copy.deepcopy(body.get("telemetry"))
        if isinstance(body.get("limits"), dict):
            _ui["limits"] = copy.deepcopy(body["limits"])
        command = body.get("command")
        if command:
            command = str(command)[:80]
            _ui["command"] = command
            _ui["command_label"] = str(body.get("label") or "")[:200]
            data = body.get("data")
            if command == "benchmark":
                data = data if isinstance(data, dict) else {}
                slot = "B" if data.get("slot") == "B" else "A"
                try:
                    duration_ms = int(float(data.get("durationMs", 6000)))
                except (TypeError, ValueError, OverflowError):
                    duration_ms = 6000
                duration_ms = max(100, min(60_000, duration_ms))
                _ui["command_data"] = {"slot": slot, "durationMs": duration_ms}
            else:
                # Only benchmark consumes command data. Drop any unrelated
                # payload instead of carrying arbitrary request data across the
                # page/window bridge.
                _ui["command_data"] = None
            _ui["command_rev"] += 1
            if origin:
                _ui["origin"] = origin
        if who == "window" or body.get("watch"):
            _ui["heard"] = now
        return _ui_copy(now)


def register_routes():
    """
    Register the optional routes. Deliberately best-effort: if this ComfyUI
    build has no route registry (or the import failed), the tracker still works
    and the detached window can report that side-channel data is unavailable.
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

        @routes.get("/ants_optimizer/thumbs/info")
        async def ants_optimizer_thumbs_info(request):  # noqa: ARG001
            return web.json_response(thumb_info())

        @routes.get("/ants_optimizer/thumbs/{node_id}")
        async def ants_optimizer_thumb_get(request):
            path = read_thumb(request.match_info.get("node_id"), request.query.get("sig"))
            if not path:
                return web.Response(status=404, text="miss")
            return web.FileResponse(path, headers={"Cache-Control": "no-store", "X-Ants-Sig": safe_token(request.query.get("sig"))})

        @routes.put("/ants_optimizer/thumbs/{node_id}")
        async def ants_optimizer_thumb_put(request):
            data = await request.read()
            try:
                write_thumb(request.match_info.get("node_id"), request.query.get("sig"), data)
            except ValueError as err:
                return web.Response(status=400, text=str(err))
            return web.Response(status=204)

        @routes.delete("/ants_optimizer/thumbs/{node_id}")
        async def ants_optimizer_thumb_delete(request):
            removed = delete_thumbs(request.match_info.get("node_id"))
            return web.json_response({"removed": removed})

        @routes.post("/ants_optimizer/thumbs/sweep")
        async def ants_optimizer_thumb_sweep(request):  # noqa: ARG001
            return web.json_response({"removed": sweep_thumbs()})

        @routes.get("/ants_optimizer/window")
        async def ants_optimizer_window(request):  # noqa: ARG001
            path = os.path.join(os.path.dirname(__file__), "web", "window.html")
            if not os.path.isfile(path):
                return web.Response(status=404, text="missing")
            return web.FileResponse(path, headers={"Cache-Control": "no-store"})

        @routes.get("/ants_optimizer/ui")
        async def ants_optimizer_ui_get(request):
            return web.json_response(ui_snapshot(hear=request.query.get("from") == "window"))

        @routes.post("/ants_optimizer/ui")
        async def ants_optimizer_ui_post(request):
            try:
                body = await request.json()
            except Exception:
                return web.json_response({"ok": False, "error": "bad json"}, status=400)
            try:
                return web.json_response(ui_update(body))
            except ValueError as err:
                return web.json_response({"ok": False, "error": str(err)}, status=400)

    except Exception:  # pragma: no cover - a route may already exist on reload
        return False
    return True


register_routes()


class ANTsFrontendOptimizer:
    """
    Dummy node. Its only job is to carry the compact power/gear pill (added on
    the JS side) that opens the detached optimizer window. The tool itself runs
    from page load whether or not this node is in the graph.
    """

    CATEGORY = "ANTs"
    FUNCTION = "noop"
    RETURN_TYPES = ()
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    def noop(self):
        return ()


# Saved workflows store the class key. The old key stays so those graphs still load.
ANTsNastyBastardsTracker = ANTsFrontendOptimizer

NODE_CLASS_MAPPINGS = {
    "ANTs_Frontend_Optimizer": ANTsFrontendOptimizer,
    "ANTsNastyBastardsTracker": ANTsFrontendOptimizer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ANTs_Frontend_Optimizer": "ANTs Frontend Optimizer",
    "ANTsNastyBastardsTracker": "ANTs Frontend Optimizer",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
