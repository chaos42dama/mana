"""Real-process regression tests for the run lifetime lock."""

import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().with_name("mana-run-lock.py")


class RunLockTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.run_dir = Path(self.temp.name)

    def argv(self, command, run_dir=None, owner="test-session"):
        return [sys.executable, str(SCRIPT), str(run_dir or self.run_dir), owner, "--", *command]

    def run_command(self, command=None, **kwargs):
        return subprocess.run(
            self.argv(command or [sys.executable, "-c", "pass"], **kwargs),
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )

    def wait_ready(self, path, proc):
        deadline = time.monotonic() + 5
        while not path.exists():
            self.assertIsNone(proc.poll(), "owner exited before readiness")
            self.assertLess(time.monotonic(), deadline, "owner readiness timed out")
            time.sleep(0.01)

    def start_owner(self, code=None):
        ready = self.run_dir / "ready"
        code = code or ("import pathlib,sys; pathlib.Path(sys.argv[1]).touch(); sys.stdin.readline()")
        # Both the lock launcher and shell must preserve the same PID/FD.
        proc = subprocess.Popen(
            self.argv(["/bin/sh", "-c", 'exec "$@"', "sh", sys.executable, "-c", code, str(ready)]),
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )

        def cleanup():
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.communicate(timeout=5)

        self.addCleanup(cleanup)
        self.wait_ready(ready, proc)
        return proc

    def test_contender_has_no_side_effect_and_normal_exit_allows_takeover(self):
        owner = self.start_owner()
        lock = self.run_dir / "orchestrator.lock"
        inode = lock.stat().st_ino
        metadata = lock.read_text()
        side_effect = self.run_dir / "unexpected"
        result = self.run_command(
            [
                sys.executable,
                "-c",
                "import pathlib,sys; pathlib.Path(sys.argv[1]).touch()",
                str(side_effect),
            ]
        )
        self.assertEqual(result.returncode, 73, result.stderr)
        self.assertIn("locked", result.stderr)
        self.assertFalse(side_effect.exists())
        self.assertEqual(lock.read_text(), metadata)
        owner.communicate(input=b"exit\n", timeout=5)
        self.assertEqual(owner.returncode, 0)
        self.assertEqual(self.run_command().returncode, 0)
        self.assertEqual(lock.stat().st_ino, inode)

    def test_signals_release_without_descendants(self):
        for sig in (signal.SIGTERM, signal.SIGKILL):
            with self.subTest(signal=sig):
                (self.run_dir / "ready").unlink(missing_ok=True)
                owner = self.start_owner()
                owner.send_signal(sig)
                self.assertEqual(owner.wait(timeout=5), -sig)
                self.assertEqual(self.run_command().returncode, 0)

    def test_fork_descendant_keeps_lock_after_owner_dies(self):
        owner = self.start_owner(
            "import os,pathlib,sys,time; pid=os.fork(); "
            "pathlib.Path(sys.argv[1]).touch() if pid == 0 else None; "
            "time.sleep(60)"
        )
        owner.kill()
        owner.wait(timeout=5)
        self.assertEqual(self.run_command().returncode, 73)

    def test_cwd_and_symlink_alias_cannot_split_lock(self):
        self.start_owner()
        alias = self.run_dir / "alias"
        alias.symlink_to(self.run_dir, target_is_directory=True)
        result = subprocess.run(
            self.argv([sys.executable, "-c", "pass"], run_dir="alias"),
            cwd=self.run_dir,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        self.assertEqual(result.returncode, 73, result.stderr)

    def test_command_exit_code_and_exception_release(self):
        for code, expected in (("raise SystemExit(42)", 42), ("raise RuntimeError('test')", 1)):
            with self.subTest(code=code):
                self.assertEqual(self.run_command([sys.executable, "-c", code]).returncode, expected)
                self.assertEqual(self.run_command().returncode, 0)

    def test_exec_failure_releases(self):
        for command, expected in (([str(self.run_dir / "missing")], 127), ([str(self.run_dir)], 126)):
            with self.subTest(command=command):
                result = self.run_command(command)
                self.assertEqual(result.returncode, expected, result.stderr)
                self.assertIn("mana-run-lock:", result.stderr)
                self.assertEqual(self.run_command().returncode, 0)

    def test_invalid_inputs(self):
        for args in ([], [str(self.run_dir), "owner", "--"], [str(self.run_dir), "owner", "echo", "bad"]):
            with self.subTest(args=args):
                result = subprocess.run(
                    [sys.executable, str(SCRIPT), *args], capture_output=True, text=True, timeout=5, check=False
                )
                self.assertEqual(result.returncode, 2)
                self.assertIn("usage:", result.stderr)
        for kwargs in (
            {"owner": " "},
            {"owner": "bad\nowner"},
            {"run_dir": self.run_dir / "missing"},
            {"run_dir": SCRIPT},
        ):
            with self.subTest(kwargs=kwargs):
                result = self.run_command(**kwargs)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("mana-run-lock:", result.stderr)


if __name__ == "__main__":
    unittest.main()
