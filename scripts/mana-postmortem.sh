#!/usr/bin/env bash
# scripts/mana-postmortem.sh — run 后复盘草稿生成器（skills/mana/SKILL.md §5 第 6 条）
# 读 .mana/<run-id>/state.json 的 blockers 与 decision_log，输出逐条摘要、phase 分组计数、
# 疑似重复类目（同关键词命中 >=2 条 decision_log），并把类目映射到 AGENTS.md
# 「规则 ↔ 强制手段 ↔ 首次发现 run」对照表的规则名；映射失败明说，不静默丢弃。
# 只读工具：不改 state、不建文件。
set -euo pipefail

if [[ $# -lt 1 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
用法: bash scripts/mana-postmortem.sh <run-dir> [--json]
  <run-dir>  含 state.json 的 run 目录（如 .mana/run-30-postmortem-20261004）
  --json     以 JSON 输出同一结果
输出:
  - blockers 逐条摘要
  - decision_log 逐条摘要 + 按 phase 分组计数
  - 疑似重复类目（同关键词命中 >=2 条 decision_log）及其位置
  - 类目映射到 AGENTS.md 对照表规则名；失败时输出「对照表中无对应规则 → 按 SKILL.md §5 补一行」
退出码: 0 正常 | 2 用法错误 | 3 state.json 不可读
EOF
  [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && exit 0 || exit 2
fi

run_dir=$1; shift
as_json=0
for a in "$@"; do [[ $a == "--json" ]] && as_json=1; done
state="$run_dir/state.json"
if [[ ! -r $state ]]; then
  echo "mana-postmortem: 不可读: $state" >&2
  exit 3
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 - "$state" "$REPO_ROOT/AGENTS.md" "$as_json" <<'PYEOF'
import json, sys
from collections import Counter
from pathlib import Path

state_path, agents_path, as_json = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
state = json.loads(Path(state_path).read_text())
run_name = state.get("run_id") or Path(state_path).parent.name

blockers = state.get("blockers") or []
dlog = state.get("decision_log") or []

def entry_text(e):
    if isinstance(e, str):
        return e
    return " ".join(str(e.get(k, "")) for k in
                    ("decision", "decided", "reason", "evidence", "result", "source", "text", "summary") if e.get(k))

def one(e, *keys):
    if isinstance(e, str):
        return e
    for k in keys:
        v = e.get(k)
        if v:
            return v
    return ""

# mistake class 关键词组 → AGENTS.md 对照表「规则」列子串
CLASSES = [
    (("格式化", "format", "deferred", "checkout"), "工作树残留格式化脏改动"),
    (("冲突", "并行", "作废", "重验"), "verdict 绑定 `head_sha`"),
    (("守卫未", "未复跑", "跳过守卫", "越界"), "守卫未实跑就 merge"),
    (("--model", "model_change", "线路锁死"), "工人线路被 `--model` 锁死回流"),
    (("确认 UI", "confirm", "MANA_WORKER"), "确认 UI / `MANA_WORKER` 未生效"),
    (("brief", "禁令"), "工人 brief 漏写禁令导致打回"),
    (("prompt", "--wait", "超时"), "`--wait` 超时被误当未投递"),
    (("unknown option", "worktree remove", "delete-branch"), "herdr/gh CLI 参数形态误用"),
    (("drill",), "契约无常驻 drill"),
]

try:
    rules_text = Path(agents_path).read_text()
except OSError:
    rules_text = ""

texts = [entry_text(d) for d in dlog]
dupes = []
for kws, rule in CLASSES:
    hits = [i for i, t in enumerate(texts) if any(k.lower() in t.lower() for k in kws)]
    if len(hits) >= 2:
        if rules_text and rule in rules_text:
            mapped = f"对照表规则: {rule}"
        else:
            mapped = "对照表中无对应规则 → 按 SKILL.md §5 补一行"
        dupes.append({"keywords": list(kws), "locations": hits, "rule": mapped})

phase_counts = dict(Counter(one(d, "phase") or "?" for d in dlog))

if as_json:
    print(json.dumps({
        "run": run_name,
        "blockers": blockers,
        "decision_log": dlog,
        "phase_counts": phase_counts,
        "suspected_classes": dupes,
    }, ensure_ascii=False, indent=2))
    sys.exit(0)

print(f"== mana-postmortem: {run_name} ==")
print(f"state: {state_path}\n")

print(f"-- blockers ({len(blockers)} 条) --")
if not blockers:
    print("无")
for i, b in enumerate(blockers):
    print(f"[B{i}] {one(b, 'time', 'at')} {entry_text(b)[:200]}")

print(f"\n-- decision_log ({len(dlog)} 条) --")
if not dlog:
    print("无")
for i, d in enumerate(dlog):
    print(f"[D{i}] {one(d, 'time', 'at')} phase={one(d, 'phase') or '?'} {one(d, 'decision', 'decided')[:160]}")

print("\n-- phase 分组计数 --")
for p, n in sorted(phase_counts.items()):
    print(f"{p}: {n}")

print("\n-- 疑似重复类目（同关键词命中 >=2 条 decision_log） --")
if not dupes:
    print("无")
for c in dupes:
    loc = ", ".join(f"decision_log[{i}]" for i in c["locations"])
    print(f"· 关键词 {c['keywords']} 命中: {loc}")
    print(f"  → {c['rule']}")
PYEOF
