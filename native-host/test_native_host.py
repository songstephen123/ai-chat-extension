import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("native-host.py")


def load_native_host():
    spec = importlib.util.spec_from_file_location("native_host", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NativeHostTest(unittest.TestCase):
    def setUp(self):
        self.native_host = load_native_host()

    def test_generate_jwt_rejects_invalid_api_key_format(self):
        with self.assertRaisesRegex(ValueError, "Invalid Zhipu API key format"):
            self.native_host.generate_jwt("not-a-zhipu-key")

    def test_handle_slides_uses_configured_output_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(os.environ, {"AI_CHAT_EXTENSION_OUTPUT_DIR": tmpdir}):
                result = self.native_host.handle_slides({
                    "title": "Configurable Output",
                    "content": "# One\n\nBody",
                })

            self.assertTrue(result["success"])
            self.assertEqual(Path(result["path"]).parent, Path(tmpdir))
            self.assertTrue(Path(result["path"]).exists())

    def test_frontend_slides_prepare_uses_configured_output_dir(self):
        def fake_handle_lark(args):
            if args.get("action") == "fetch_doc":
                return {"success": True, "stdout": "# Deck Title\n\n## Point\nBody"}
            return {"success": False, "error": "unexpected action"}

        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(os.environ, {"AI_CHAT_EXTENSION_OUTPUT_DIR": tmpdir}):
                original = self.native_host.handle_lark
                self.native_host.handle_lark = fake_handle_lark
                try:
                    result = self.native_host.handle_frontend_slides({
                        "url": "https://example.feishu.cn/docx/doc-id",
                        "mode": "prepare",
                    })
                finally:
                    self.native_host.handle_lark = original

            self.assertTrue(result["success"])
            self.assertTrue(Path(result["work_dir"]).is_relative_to(Path(tmpdir)))
            self.assertTrue(Path(result["source_path"]).exists())
            self.assertTrue(Path(result["prompt_path"]).exists())

    def test_common_lark_actions_use_lark_cli_binary(self):
        calls = []

        def fake_run_command(cmd, timeout=60):
            calls.append(cmd)
            return {"success": True, "stdout": "{}", "stderr": "", "returncode": 0}

        original = self.native_host.run_command
        self.native_host.run_command = fake_run_command
        try:
            self.native_host.handle_lark({"action": "search_docs", "query": "roadmap"})
            self.native_host.handle_lark({"action": "fetch_doc", "url": "doc-id"})
            self.native_host.handle_lark({"action": "create_task", "title": "Follow up"})
        finally:
            self.native_host.run_command = original

        self.assertEqual([cmd[0] for cmd in calls], ["lark-cli", "lark-cli", "lark-cli"])


if __name__ == "__main__":
    unittest.main()
