"""check-mana-issue.py 的真实进程回归测试（subprocess 调脚本断言退出码与文案）。"""

import subprocess
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().with_name("check-mana-issue.py")

FULL_BODY = "\n".join(
    [
        "# 某目标",
        "## Depends on",
        "- 父 Issue：#12",
        "- 前置：无。",
        "## Files（边界）",
        "- `scripts/x.py`（新建）",
        "### Build",
        "- 标准库实现。",
        "**Verify（unit、live）**",
        "- unit（lane 自证）：`--self-test` → exit 0",
        "- live（合成 drill）：真实命令实跑 → exit 0",
        "## Review gate",
        "- PR 描述贴验收实际输出。",
        "## Merge",
        "- squash merge 后清理。",
    ]
)


def run(body: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--body", "-"],
        input=body, capture_output=True, text=True, timeout=10, check=False,
    )


class CheckManaIssueTest(unittest.TestCase):
    def test_full_skeleton_passes(self):
        result = run(FULL_BODY)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("6 段齐备", result.stdout)

    def test_each_missing_section_fails_and_names_it(self):
        lines = FULL_BODY.splitlines()
        for name in ("Depends on", "Files", "Build", "Verify", "Review gate", "Merge"):
            with self.subTest(section=name):
                start = next(i for i, ln in enumerate(lines) if ln.lstrip("#* ").startswith(name))
                end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith(("#", "**"))), len(lines))
                broken = "\n".join(lines[:start] + lines[end:])
                result = run(broken)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(name, result.stdout + result.stderr)

    def test_verify_without_unit_or_live_fails(self):
        for sub in ("unit", "live"):
            with self.subTest(sub=sub):
                result = run(FULL_BODY.replace(f"- {sub}", "- 其它"))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"缺 `{sub}` 子项", result.stdout + result.stderr)

    def test_cli_errors(self):
        result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--body", result.stderr)

    def test_empty_body_lists_all_missing(self):
        result = run("")
        self.assertEqual(result.returncode, 1)
        out = result.stdout + result.stderr
        for name in ("Depends on", "Files", "Build", "Verify", "Review gate", "Merge"):
            self.assertIn(name, out)


if __name__ == "__main__":
    unittest.main()
