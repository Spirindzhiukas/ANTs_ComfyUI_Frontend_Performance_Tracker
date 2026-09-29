#!/usr/bin/env python3
"""Python-side tests:  python3 tests/test_init.py

Covers the nvidia-smi parsing and the fact that the node imports cleanly (and
stays importable) outside a running ComfyUI.
"""
import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent


def load_module():
    spec = importlib.util.spec_from_file_location("ants_tracker_init", ROOT / "__init__.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class InitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_module()

    def test_web_directory_is_declared(self):
        self.assertEqual(self.mod.WEB_DIRECTORY, "web")

    def test_node_contract(self):
        node = self.mod.ANTsFrontendOptimizer()
        self.assertEqual(self.mod.ANTsFrontendOptimizer.CATEGORY, "ANTs")
        self.assertEqual(node.noop(), ())
        self.assertEqual(self.mod.ANTsFrontendOptimizer.INPUT_TYPES(), {"required": {}})
        self.assertIn("ANTs_Frontend_Optimizer", self.mod.NODE_CLASS_MAPPINGS)
        # Saved workflows store the old class key. It has to keep loading.
        self.assertIs(self.mod.NODE_CLASS_MAPPINGS["ANTsNastyBastardsTracker"], self.mod.ANTsFrontendOptimizer)
        self.assertEqual(self.mod.NODE_DISPLAY_NAME_MAPPINGS["ANTs_Frontend_Optimizer"], "ANTs Frontend Optimizer")

    def test_thumbnails_are_keyed_overwritten_and_swept(self):
        import tempfile
        import time

        png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
        with tempfile.TemporaryDirectory() as tmp:
            self.mod.set_thumb_root(tmp)
            try:
                self.assertEqual(self.mod.safe_token("../etc/passwd"), "etc_passwd")
                self.assertNotIn("/", self.mod.safe_token("../etc/passwd"))
                self.assertEqual(self.mod.safe_token("..\\\\windows"), "windows")
                self.assertEqual(self.mod.safe_token(""), "")
                path = self.mod.write_thumb("12", "abc", png)
                self.assertTrue(path.endswith("12__abc.png"))
                self.assertEqual(self.mod.read_thumb("12", "abc"), path)
                self.assertIsNone(self.mod.read_thumb("12", "other"), "a different signature is not this node's picture")
                # A change replaces the file. The old signature is gone.
                self.mod.write_thumb("12", "def", png)
                self.assertIsNone(self.mod.read_thumb("12", "abc"))
                self.assertIsNotNone(self.mod.read_thumb("12", "def"))
                # A week-old file goes. A fresh one stays.
                old = self.mod.write_thumb("99", "old", png)
                fresh_time = time.time()
                os_mtime = fresh_time - 8 * 24 * 60 * 60
                import os
                os.utime(old, (os_mtime, os_mtime))
                removed = self.mod.sweep_thumbs(now=fresh_time)
                self.assertEqual(removed, 1)
                self.assertIsNone(self.mod.read_thumb("99", "old"))
                self.assertIsNotNone(self.mod.read_thumb("12", "def"))
                self.assertEqual(self.mod.delete_thumbs("12"), 1)
                self.assertIsNone(self.mod.read_thumb("12", "def"))
                with self.assertRaises(ValueError):
                    self.mod.write_thumb("12", "abc", b"not an image")
                info = self.mod.thumb_info()
                self.assertEqual(info["dir"], tmp)
                self.assertEqual(info["maxAgeDays"], 7)
            finally:
                self.mod.set_thumb_root(None)

    def test_window_bus_is_a_revision_not_a_master(self):
        mod = self.mod
        mod.ui_reset()
        first = mod.ui_update({"origin": "page", "settings": {"flatBelow": 0.5}, "limits": {"flatZoom": [0, 0.5]}})
        self.assertEqual(first["rev"], 1)
        self.assertEqual(first["origin"], "page")
        self.assertEqual(first["settings"]["flatBelow"], 0.5)
        tel = mod.ui_update({"origin": "page", "telemetry": {"fps": 40}})
        self.assertEqual(tel["rev"], 1, "a live number is not a settings change")
        self.assertEqual(tel["telemetry"]["fps"], 40)
        self.assertIsNone(tel["heardAge"], "the page asking is not the window listening")
        heard = mod.ui_snapshot(hear=True)
        self.assertIsNotNone(heard["heardAge"])
        self.assertLess(heard["heardAge"], 2)
        win = mod.ui_update({"origin": "window", "settings": {"flatBelow": 0.2}})
        self.assertEqual(win["rev"], 2)
        self.assertEqual(win["origin"], "window")
        self.assertEqual(win["settings"]["flatBelow"], 0.2)
        again = mod.ui_update({"origin": "page", "telemetry": {"fps": 41}})
        self.assertEqual(again["rev"], 2)
        cmd = mod.ui_update({"origin": "window", "command": "measure-links", "label": ""})
        self.assertEqual(cmd["command"], "measure-links")
        self.assertEqual(cmd["commandRev"], 1)
        self.assertEqual(cmd["rev"], 2, "a command is not a settings revision")
        html = (ROOT / "web" / "window.html").read_text(encoding="utf-8")
        self.assertIn("/ants_optimizer/ui", html)
        self.assertIn("from=window", html)
        self.assertNotIn("window.opener", html)
        self.assertNotIn("tracker.js", html)
        self.assertIn('id="ants-window"', html)

    def test_routes_are_optional(self):
        # Outside ComfyUI there is no PromptServer, so registration must simply
        # report False instead of raising.
        self.assertIn(self.mod.register_routes(), (True, False))

    def test_parses_gpu_csv(self):
        gpu_csv = (
            "0, NVIDIA GeForce RTX 4090, 12, 18123, 24564, 61, 240.55, 450.00\n"
            "1, NVIDIA GeForce RTX 4090, [N/A], 15, 24564, 40, [Not Supported], 450.00\n"
        )
        proc_csv = "1234, /usr/bin/python3, 17900\n5678, C:\\apps\\comfy.exe, 220\n"
        payload = self.mod.parse_nvidia_smi(gpu_csv, proc_csv)
        self.assertTrue(payload["available"])
        self.assertEqual(len(payload["gpus"]), 2)
        first = payload["gpus"][0]
        self.assertEqual(first["name"], "NVIDIA GeForce RTX 4090")
        self.assertEqual(first["memory_used"], 18123)
        self.assertEqual(first["power_draw"], 240.55)
        # 'N/A' must never be reported as a number, and must not invent one.
        self.assertIsNone(payload["gpus"][1]["utilization_gpu"])
        self.assertIsNone(payload["gpus"][1]["power_draw"])
        self.assertEqual(payload["processes"][0]["name"], "python3")
        self.assertEqual(payload["processes"][1]["name"], "comfy.exe")

    def test_no_gpus_is_a_reason_not_a_crash(self):
        payload = self.mod.parse_nvidia_smi("", "")
        self.assertFalse(payload["available"])
        self.assertTrue(payload["reason"])

    def test_missing_binary_is_explained(self):
        import unittest.mock as mock

        with mock.patch("shutil.which", return_value=None):
            payload = self.mod.query_nvidia_smi()
        self.assertFalse(payload["available"])
        self.assertIn("PATH", payload["reason"])

    def test_broken_binary_is_explained(self):
        import subprocess
        import unittest.mock as mock

        def boom(*a, **k):
            raise subprocess.TimeoutExpired(cmd="nvidia-smi", timeout=5)

        with mock.patch("shutil.which", return_value="/usr/bin/nvidia-smi"), mock.patch("subprocess.run", side_effect=boom):
            payload = self.mod.query_nvidia_smi()
        self.assertFalse(payload["available"])
        self.assertIn("did not answer", payload["reason"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
