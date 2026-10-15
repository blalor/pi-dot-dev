"""Run with: python3 -m unittest discover -s <this-directory> -v."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("launch_iterm", Path(__file__).with_name("launch-iterm.py"))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.tempdir = patch.object(launcher.tempfile, "tempdir", str(self.root))
        self.tempdir.start()
        self.addCleanup(self.tempdir.stop)
        self.cwd = self.root / "checkout 'quoted' $(touch INJECTED)"
        self.cwd.mkdir()
        self.session = self.root / "source session.jsonl"
        self.session.write_text('{}\n')
        self.prompt = self.root / "prompt.txt"
        self.prompt.write_text('@not-a-file\n--help\n$(touch INJECTED)\n\'"\\')
        self.env = patch.dict(os.environ, {
            "ITERM_SESSION_ID": "w2t3p0:source-uuid",
            "PI_SESSION_FILE": str(self.session),
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.which = patch.object(launcher.shutil, "which", return_value="/fake path/pi")
        self.which.start()
        self.addCleanup(self.which.stop)

    def args(self, **overrides):
        values = dict(cwd=str(self.cwd), label="peer 'quoted' $(touch INJECTED)",
                      fork_current=False, allow_intercom=False, prompt_file=None, focus=False)
        values.update(overrides)
        return launcher.argparse.Namespace(**values)

    def test_fork_default_and_prompt_quoting(self):
        source, shell_script, result = launcher.prepare(self.args(fork_current=True, prompt_file=str(self.prompt)))
        self.assertEqual(source, "source-uuid")
        pi_command = result["recoveryCommand"].split(" && ", 1)[1]
        self.assertEqual(shlex.split(pi_command), [
            "/fake path/pi", "--name", self.args().label,
            "--fork", str(self.session), "--exclude-tools", "intercom",
            "--", "\n" + self.prompt.read_text(),
        ])
        self.assertIn(result["recoveryCommand"], shell_script)
        self.assertTrue(result["checkoutShared"])
        self.assertFalse(result["intercomToolEnabled"])

    def test_allow_intercom_and_fresh_peer(self):
        _, _, fork = launcher.prepare(self.args(fork_current=True, allow_intercom=True))
        self.assertNotIn("--exclude-tools", fork["recoveryCommand"])
        _, _, peer = launcher.prepare(self.args())
        self.assertNotIn("--fork", peer["recoveryCommand"])
        self.assertIsNone(peer["sourceSession"])
        self.assertTrue(peer["intercomToolEnabled"])
        with self.assertRaisesRegex(ValueError, "only to --fork-current"):
            launcher.prepare(self.args(allow_intercom=True))

    def test_generated_label(self):
        _, _, result = launcher.prepare(self.args(label=None))
        self.assertTrue(result["label"].startswith("pi-peer-"))

    def test_invalid_source_and_checkout(self):
        with patch.dict(os.environ, {"ITERM_SESSION_ID": ""}):
            with self.assertRaisesRegex(ValueError, "ITERM_SESSION_ID"):
                launcher.prepare(self.args())
        with patch.dict(os.environ, {"PI_SESSION_FILE": ""}):
            with self.assertRaisesRegex(ValueError, "PI_SESSION_FILE"):
                launcher.prepare(self.args(fork_current=True))
            launcher.prepare(self.args())  # Fresh peers need no source history.
        with self.assertRaisesRegex(ValueError, "directory does not exist"):
            launcher.prepare(self.args(cwd=str(self.root / "missing")))
        with self.assertRaisesRegex(ValueError, "blank"):
            launcher.prepare(self.args(label=" "))
        self.prompt.write_text("")
        with self.assertRaisesRegex(ValueError, "empty"):
            launcher.prepare(self.args(prompt_file=str(self.prompt)))
        with patch.object(launcher.shutil, "which", return_value=None):
            with self.assertRaisesRegex(ValueError, "not found: pi"):
                launcher.prepare(self.args())

    def test_shell_exec_preserves_data(self):
        fake_pi = self.root / "fake pi"
        capture = self.root / "argv.json"
        fake_pi.write_text('#!/usr/bin/env python3\nimport json, os, sys\n'
                           'with open(os.environ["CAPTURE"], "w") as f:\n'
                           '    json.dump({"argv": sys.argv[1:], "cwd": os.getcwd()}, f)\n')
        fake_pi.chmod(0o755)
        with patch.object(launcher.shutil, "which", return_value=str(fake_pi)):
            _, _, result = launcher.prepare(self.args(prompt_file=str(self.prompt)))
        subprocess.run(["/bin/zsh", "-c", result["recoveryCommand"]], check=True,
                       env={**os.environ, "CAPTURE": str(capture)})
        actual = json.loads(capture.read_text())
        self.assertEqual(actual["cwd"], str(self.cwd))
        self.assertEqual(actual["argv"], ["--name", self.args().label, "--", "\n" + self.prompt.read_text()])
        self.assertFalse((self.cwd / "INJECTED").exists())

    def test_launch_passes_data_as_argv(self):
        output = io.StringIO()
        with patch.object(launcher.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "42\nnew-session\n", "")) as run:
            with contextlib.redirect_stdout(output):
                self.assertEqual(launcher.main(["--cwd", str(self.cwd), "--label", "peer", "--focus"]), 0)
        call = run.call_args
        self.assertEqual(call.args[0][:3], ["osascript", "-", "source-uuid"])
        self.assertEqual(call.args[0][-2:], ["peer", "true"])
        self.assertEqual(call.kwargs["input"], launcher.APPLESCRIPT)
        command = shlex.split(call.args[0][3])
        self.assertEqual(command[:2], ["/bin/zsh", "-l"])
        script = Path(command[2])
        self.assertEqual(script.stat().st_mode & 0o777, 0o600)
        self.assertTrue(script.read_text().startswith('rm -f -- "$0"\n'))
        self.assertNotIn("source-uuid", script.read_text())
        result = json.loads(output.getvalue())
        self.assertEqual(result["state"], "command-submitted")
        self.assertEqual(result["terminalSession"], "new-session")
        self.assertEqual(result["window"], "42")

    def test_failure_preserves_tab(self):
        for failure in [subprocess.CalledProcessError(1, "osascript", stderr="denied"),
                        OSError("missing osascript")]:
            with self.subTest(failure=failure), patch.object(launcher.subprocess, "run", side_effect=failure):
                output = io.StringIO()
                with contextlib.redirect_stderr(output):
                    self.assertEqual(launcher.main(["--cwd", str(self.cwd)]), 1)
                self.assertIn("preserve it", output.getvalue())
        with patch.object(launcher.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "bad response", "")):
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(launcher.main(["--cwd", str(self.cwd)]), 1)


if __name__ == "__main__":
    unittest.main()
