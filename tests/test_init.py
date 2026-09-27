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
        node = self.mod.ANTsNastyBastardsTracker()
        self.assertEqual(self.mod.ANTsNastyBastardsTracker.CATEGORY, "ANTs/debug")
        self.assertEqual(node.noop(), ())
        self.assertEqual(self.mod.ANTsNastyBastardsTracker.INPUT_TYPES(), {"required": {}})
        self.assertIn("ANTsNastyBastardsTracker", self.mod.NODE_CLASS_MAPPINGS)

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
