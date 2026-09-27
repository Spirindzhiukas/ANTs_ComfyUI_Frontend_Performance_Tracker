"""
ANTs Nasty Bastards Tracker
============================

A lightweight, in-page profiler for the ComfyUI *frontend*, not the
Python backend. It answers one question: "which extension's UI code
is actually costing me frames when I pan/zoom a heavy graph?"

How it works (see web/tracker.js for the real logic):
  1. It patches `app.registerExtension` itself, as early as possible
     (this folder is prefixed 0000_ so it loads before other custom
     nodes' web directories, alphabetically).
  2. For every OTHER extension that registers a `beforeRegisterNodeDef`
     hook, it wraps whatever draw-related callbacks that hook attaches
     to a node type (onDrawForeground, onDrawBackground, etc.) with a
     timer, tagged with that extension's name.
  3. It wraps the canvas's own top-level draw() call to get a total
     per-frame cost, and reports "unattributed" time as whatever isn't
     accounted for by a tagged extension (this catches nodes that
     patch LiteGraph's prototypes directly instead of going through
     the sanctioned registerExtension API).
  4. A floating overlay panel shows all of this live, sortable, with a
     per-extension "mute" toggle so you can bisect a slow graph without
     restarting ComfyUI or moving folders around.

This node's Python side does almost nothing on purpose. The tracking
engine itself starts automatically at page load (because it lives
under WEB_DIRECTORY, which ComfyUI serves to every browser tab
regardless of whether this node is ever placed in a workflow). This
node exists only to give you a button, in the graph, to show/hide the
overlay panel. A small persistent corner toggle is also injected into
the page for the same purpose, in case you don't want to keep a node
around just for that.

Safe to drop into any workflow. It has no inputs, no outputs, and
never executes anything on the backend.
"""

WEB_DIRECTORY = "web"


class ANTsNastyBastardsTracker:
    """
    Dummy node. Its only job is to carry a widget button (added on the
    JS side) that opens the ANTs Nasty Bastards Tracker overlay panel.
    The tracker itself runs continuously from page load regardless of
    whether this node exists in your graph or is connected to anything.
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
