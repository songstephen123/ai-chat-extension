import importlib.util
import os
import tempfile
import unittest
import json
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

    def test_lark_capabilities_exposes_core_domains(self):
        result = self.native_host.handle_lark({"action": "capabilities"})

        self.assertTrue(result["success"])
        self.assertIn("base", result["domains"])
        self.assertIn("sheets", result["domains"])
        self.assertIn("docs", result["domains"])
        self.assertIn("recommended_flow", result)

    def test_lark_shortcut_builds_structured_argv(self):
        calls = []

        def fake_run_command(cmd, timeout=60):
            calls.append(cmd)
            return {"success": True, "stdout": "{}", "stderr": "", "returncode": 0}

        original = self.native_host.run_command
        self.native_host.run_command = fake_run_command
        try:
            result = self.native_host.handle_lark({
                "action": "shortcut",
                "service": "sheets",
                "shortcut": "+create",
                "args": {"title": "周报"},
                "dry_run": True,
            })
        finally:
            self.native_host.run_command = original

        self.assertTrue(result["success"])
        self.assertEqual(calls[0], ["lark-cli", "sheets", "+create", "--title", "周报", "--dry-run"])

    def test_lark_api_command_builds_service_resource_method_argv(self):
        calls = []

        def fake_run_command(cmd, timeout=60):
            calls.append(cmd)
            return {"success": True, "stdout": "{}", "stderr": "", "returncode": 0}

        original = self.native_host.run_command
        self.native_host.run_command = fake_run_command
        try:
            result = self.native_host.handle_lark({
                "action": "api_command",
                "service": "calendar",
                "resource": "events",
                "method": "create",
                "params": {"calendar_id": "primary"},
                "data": {"summary": "站会"},
                "as": "user",
            })
        finally:
            self.native_host.run_command = original

        self.assertTrue(result["success"])
        self.assertEqual(calls[0][:5], ["lark-cli", "calendar", "events", "create", "--format"])
        self.assertEqual(calls[0][5], "json")
        self.assertIn("--params", calls[0])
        self.assertIn(json.dumps({"calendar_id": "primary"}, ensure_ascii=False), calls[0])
        self.assertIn("--data", calls[0])
        self.assertIn(json.dumps({"summary": "站会"}, ensure_ascii=False), calls[0])
        self.assertIn("--as", calls[0])
        self.assertIn("user", calls[0])

    def test_lark_shortcut_rejects_blocked_confirmation_flag(self):
        result = self.native_host.handle_lark({
            "action": "shortcut",
            "service": "drive",
            "shortcut": "+delete",
            "args": {"yes": True},
        })

        self.assertFalse(result["success"])
        self.assertIn("--yes is blocked", result["error"])

    def test_lark_passthrough_runs_full_business_argv_json(self):
        calls = []

        def fake_run_command(cmd, timeout=60):
            calls.append(cmd)
            return {"success": True, "stdout": "{}", "stderr": "", "returncode": 0}

        original = self.native_host.run_command
        self.native_host.run_command = fake_run_command
        try:
            result = self.native_host.handle_lark({
                "action": "passthrough",
                "argv_json": json.dumps([
                    "base", "records", "list",
                    "--params", json.dumps({"app_token": "app123"}, ensure_ascii=False),
                    "--page-all",
                    "--jq", ".data.items"
                ], ensure_ascii=False),
            })
        finally:
            self.native_host.run_command = original

        self.assertTrue(result["success"])
        self.assertEqual(calls[0], [
            "lark-cli", "base", "records", "list",
            "--params", json.dumps({"app_token": "app123"}, ensure_ascii=False),
            "--page-all",
            "--jq", ".data.items",
        ])

    def test_lark_passthrough_rejects_sensitive_roots(self):
        for root in ("auth", "config", "profile", "update"):
            with self.subTest(root=root):
                result = self.native_host.handle_lark({
                    "action": "passthrough",
                    "argv_json": json.dumps([root, "--help"]),
                })
                self.assertFalse(result["success"])
                self.assertIn("Blocked lark-cli command root", result["error"])

    def test_lark_passthrough_rejects_yes_variants(self):
        for arg in ("--yes", "--yes=true", "--yes=false"):
            with self.subTest(arg=arg):
                result = self.native_host.handle_lark({
                    "action": "passthrough",
                    "argv_json": json.dumps(["drive", "+delete", arg]),
                })
                self.assertFalse(result["success"])
                self.assertIn("--yes is blocked", result["error"])


if __name__ == "__main__":
    unittest.main()
