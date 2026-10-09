#!/usr/bin/env bash
# /mana 全仓自检入口（10 步，顺序固定）：契约 check 聚合 + tier 守卫/run 锁/issue 校验自检与测试 + 五个宿主扩展内联自检。
# 不早退：任一步失败仍跑完其余，末尾逐项汇总，末行 `ALL-<n>-rc=<0|1>`
#（n=实际执行步数，不含 SKIP；命名对齐 checks/all.check.mjs 的末行计数惯例）。
# 用法：bash scripts/mana-selftest.sh [--list] [--quick] [--only <子串>] [--force-contracts]
#   --list              只列步骤，不执行
#   --quick             只跑前 5 步（契约 + python 自检），跳过 bun 扩展步（run 预检 d 门用这个档）
#   --only <子串>       按步骤名过滤；无匹配即非 0（防过滤笔误假绿）
#   --force-contracts   顶层显式声明必须真跑 contracts（预检 d 门用）；若环境已带嵌套标记仍让位（见下）
# 缺工具降级（与 run 预检 pig 门同语义：可选依赖缺失不把机器挡死）：
#   node/python3 缺失 ⇒ 依赖它的步 SKIP；bun 缺失 ⇒ 5 个扩展步全部 SKIP 并醒目提示。
# 环境卫生：每步一律 `env -u MANA_WORKER` 执行——扩展自检的 decideCommit 默认参读 env，
#   工人 pane 里跑会自证失败；预检验证的是扩展逻辑本身，剥掉 pane 的工人态。
# MANA_SELFTEST_EXTRA_CMD（仅供测试注入的负例钩子，正常使用不要设）：非空时作为追加步执行，
#   用于证明本脚本对失败步骤真的非 0（如 MANA_SELFTEST_EXTRA_CMD=false ⇒ 总码非 0 并点名该步）。
# 本脚本绝不调用 run 预检脚本（预检 d 门会调本脚本，互调即死循环）。
# 反向环切断（本脚本侧）：预检 d 门→本脚本→all.check→pig-gate check 会反向调回预检成环。
# 本脚本顶层 export MANA_SELFTEST_ACTIVE=1 一次，全部子步继承；再入本脚本（启动时标记已在
# 环境）即 SKIP contracts——上层自检已在跑全部契约，重入只成环不增益。--force-contracts
# 只表达顶层意图，标记优先：嵌套重入即使带该参数也 SKIP（防递归优先于防丢覆盖）。
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 步骤表：名称|命令|依赖工具（依赖缺失 ⇒ SKIP）
STEPS=(
  "contracts|node checks/all.check.mjs|node"
  "grant-scope|python3 scripts/check-mana-grant-scope.py --self-test|python3"
  "run-lock|python3 scripts/test_mana_run_lock.py|python3"
  "issue-check|python3 scripts/check-mana-issue.py --self-test|python3"
  "issue-check-tests|python3 scripts/test_check_mana_issue.py|python3"
  "ext-worker|PI_MANA_WORKER_SELFTEST=1 bun extensions/pi/mana-worker.ts|bun"
  "ext-safe-guard|PI_SAFE_GUARD_SELFTEST=1 bun extensions/pi/safe-guard.ts|bun"
  "ext-precommit|PI_PRECOMMIT_SELFTEST=1 bun extensions/pi/precommit-review.ts|bun"
  "ext-worker-compact|PI_MANA_WORKER_COMPACT_SELFTEST=1 bun extensions/pi/mana-worker-compact.ts|bun"
  "ext-compact|MANA_COMPACT_SELFTEST=1 bun extensions/mana-compact.ts|bun"
)

LIST=0 QUICK=0 FORCE=0 ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
  --list) LIST=1 ;;
  --quick) QUICK=1 ;;
  --force-contracts) FORCE=1 ;;
  --only)
    shift
    ONLY="${1:-}"
    [ -n "$ONLY" ] || {
      echo "FAIL: --only 需要一个子串参数" >&2
      exit 2
    }
    ;;
  *)
    echo "FAIL: 未知参数 $1（用法见文件头注释）" >&2
    exit 2
    ;;
  esac
  shift
done

# 过滤：--quick 砍掉后 5 个 bun 扩展步；--only 按步骤名子串过滤（无匹配 ⇒ 非 0）
if [ "$QUICK" = "1" ]; then STEPS=("${STEPS[@]:0:5}"); fi
if [ -n "$ONLY" ]; then
  FILTERED=()
  for e in "${STEPS[@]}"; do
    case "${e%%|*}" in *"$ONLY"*) FILTERED+=("$e") ;; esac
  done
  if [ "${#FILTERED[@]}" -eq 0 ]; then
    echo "FAIL: --only '$ONLY' 无匹配步骤（防过滤笔误假绿；--list 查看全部步骤名）" >&2
    exit 1
  fi
  STEPS=("${FILTERED[@]}")
fi

if [ "$LIST" = "1" ]; then
  for e in "${STEPS[@]}"; do echo "${e%%|*}"; done
  exit 0
fi

have() { command -v "$1" >/dev/null 2>&1; }

# 嵌套检测必须先于 export：读的是继承环境，export 只影响子进程。
if [ -n "${MANA_SELFTEST_ACTIVE:-}" ]; then NESTED=1; else NESTED=0; fi
export MANA_SELFTEST_ACTIVE=1

RAN=0 FAILED=0 BUN_NOTED=0
for e in "${STEPS[@]}"; do
  name="${e%%|*}"
  rest="${e#*|}"
  cmd="${rest%%|*}"
  tool="${rest##*|}"
  if [ "$name" = "contracts" ] && [ "$NESTED" = "1" ]; then
    echo "SKIP contracts（检测到 MANA_SELFTEST_ACTIVE：本进程已在另一自检的子进程里，重跑会经 pig-gate check 反向调回预检成环；契约回归面由上层自检承担${FORCE:+，--force-contracts 已被嵌套标记否决}）"
    continue
  fi
  if ! have "$tool"; then
    if [ "$tool" = "bun" ] && [ "$BUN_NOTED" = "0" ]; then
      echo "⚠ bun 不可用：5 个扩展自检步全部 SKIP（可选依赖缺失不挡死；装 bun 后重跑全量）" >&2
      BUN_NOTED=1
    fi
    echo "SKIP $name（缺 $tool，降级跳过）"
    continue
  fi
  OUT="$(mktemp)"
  if (cd "$REPO_ROOT" && env -u MANA_WORKER bash -c "$cmd") >"$OUT" 2>&1; then
    echo "✓ $name"
  else
    FAILED=1
    echo "✗ $name（输出末尾 10 行：）"
    tail -n 10 "$OUT" | sed 's/^/    /'
  fi
  rm -f "$OUT"
  RAN=$((RAN + 1))
done

# 负例钩子（仅供测试注入）：非空则追加执行，非 0 ⇒ 总码非 0 并点名该步
if [ -n "${MANA_SELFTEST_EXTRA_CMD:-}" ]; then
  OUT="$(mktemp)"
  if (cd "$REPO_ROOT" && env -u MANA_WORKER bash -c "$MANA_SELFTEST_EXTRA_CMD") >"$OUT" 2>&1; then
    echo "✓ MANA_SELFTEST_EXTRA_CMD"
  else
    FAILED=1
    echo "✗ MANA_SELFTEST_EXTRA_CMD=$MANA_SELFTEST_EXTRA_CMD（输出末尾 10 行：）"
    tail -n 10 "$OUT" | sed 's/^/    /'
  fi
  rm -f "$OUT"
  RAN=$((RAN + 1))
fi

echo "ALL-${RAN}-rc=${FAILED}"
exit "$FAILED"
