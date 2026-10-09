"""Real-process regression tests for the self-test entrypoint (mana-selftest.sh).

含两条真负例（历史坑：负例曾永真通过，这里断言真非 0 且输出点名失败步）：
A. MANA_SELFTEST_EXTRA_CMD=false 注入 ⇒ 总码非 0 且输出点名 MANA_SELFTEST_EXTRA_CMD；
B. MANA_PREFLIGHT_SELFTEST_CMD=false 注入预检 ⇒ 非 0 且 stderr 含 `PREFLIGHT FAIL: 自检门`。
另含反向环切断用例：嵌套标记 ⇒ SKIP contracts；--force-contracts 顶层 ⇒ contracts 真跑。
"""

import os
import subprocess
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().with_name("mana-selftest.sh")
PREFLIGHT = Path(__file__).resolve().with_name("mana-preflight.sh")
STEP_NAMES = [
    "contracts",
    "grant-scope",
    "run-lock",
    "issue-check",
    "issue-check-tests",
    "ext-worker",
    "ext-safe-guard",
    "ext-precommit",
    "ext-worker-compact",
    "ext-compact",
]
# 阴性注入专用：跳过线路冒烟（文件头注明仅 T 类阴性测试注入用）
NEGATIVE_ENV = {"MANA_PREFLIGHT_SKIP_SMOKE": "1"}

# 测试套件启动时（import 时，任何用例实跑前）的工作树快照。断言对象是「测试自身不新增
# 污染」（前后快照相同），不是「工作树本来干净」——后者在有未提交交付物的树上必然假红。
TREE_AT_START = subprocess.run(
    ["git", "status", "--short"], capture_output=True, text=True, check=True
).stdout.strip()


def run(args, env_extra=None):
    env = dict(os.environ)
    env.pop("MANA_SELFTEST_ACTIVE", None)  # 默认顶层态；嵌套用例经 env_extra 显式注入
    env.update(NEGATIVE_ENV)
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        args, capture_output=True, text=True, timeout=600, env=env, check=False
    )


class ManaSelftestTest(unittest.TestCase):
    def test_list_contains_all_ten_steps(self):
        r = run(["bash", str(SCRIPT), "--list"])
        self.assertEqual(r.returncode, 0, r.stderr)
        for name in STEP_NAMES:
            self.assertIn(name, r.stdout)

    def test_quick_runs_five_steps_without_bun(self):
        r = run(["bash", str(SCRIPT), "--quick"])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("ALL-5-rc=0", r.stdout)
        for name in STEP_NAMES[5:]:
            self.assertNotIn(name, r.stdout)
        self.assertNotIn("bun ", r.stdout, "--quick 不得出现 bun 执行")

    def test_only_without_match_fails(self):
        r = run(["bash", str(SCRIPT), "--only", "绝不存在的步骤名"])
        self.assertNotEqual(r.returncode, 0)

    def test_nested_marker_skips_contracts(self):
        r = run(["bash", str(SCRIPT), "--quick"], {"MANA_SELFTEST_ACTIVE": "1"})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("SKIP contracts", r.stdout, "嵌套重入必须 SKIP contracts（切环）")
        self.assertNotIn("✓ contracts", r.stdout)
        self.assertIn("ALL-4-rc=0", r.stdout)  # 5 步 − contracts，只真跑 4 步

    def test_force_contracts_runs_contracts_at_top_level(self):
        r = run(["bash", str(SCRIPT), "--quick", "--force-contracts"])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn(
            "✓ contracts", r.stdout, "顶层 --force-contracts 必须真跑 contracts"
        )
        self.assertIn("ALL-5-rc=0", r.stdout)

    def test_negative_extra_cmd_makes_selftest_fail(self):
        r = run(["bash", str(SCRIPT), "--quick"], {"MANA_SELFTEST_EXTRA_CMD": "false"})
        self.assertNotEqual(r.returncode, 0, "负例必须真非 0（防永真负例）")
        self.assertIn("MANA_SELFTEST_EXTRA_CMD", r.stdout, "输出须点名失败步")

    def test_negative_preflight_hook_makes_preflight_fail(self):
        r = run(["bash", str(PREFLIGHT)], {"MANA_PREFLIGHT_SELFTEST_CMD": "false"})
        self.assertNotEqual(r.returncode, 0, "负例必须真非 0（防永真负例）")
        self.assertIn("PREFLIGHT FAIL: 自检门", r.stderr)

    def test_tree_stays_clean(self):
        r = run(["git", "status", "--short"])
        self.assertEqual(r.returncode, 0)
        self.assertEqual(
            r.stdout.strip(), TREE_AT_START, "运行测试不得新增工作树污染（前后快照须相同）"
        )


if __name__ == "__main__":
    unittest.main()
