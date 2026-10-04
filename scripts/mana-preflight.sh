#!/usr/bin/env bash
# /mana run 预检（SKILL.md §1.4 第 4 条的脚本化）：环境/pi/线路/自检/装机/pig/配置 七门。
# 任一门 FAIL 立即非 0 退出并打印 `PREFLIGHT FAIL: <原因>`；WARN 只告警不停。
# 用法：bash scripts/mana-preflight.sh
# MANA_PREFLIGHT_SKIP_SMOKE=1 跳过 pi -p 线路冒烟（仅 T 类阴性测试注入用，正常 run 不用）。
set -u

FAIL() { echo "PREFLIGHT FAIL: $1" >&2; exit 1; }
WARN() { echo "PREFLIGHT WARN: $1" >&2; }
OK()   { echo "ok: $1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── a. 环境门 ────────────────────────────────────────────────────────────────
[ "${MANA_AUTONOMOUS:-}" = "1" ] || FAIL "环境门: MANA_AUTONOMOUS 未设为 1（否则 safe-guard 会在 run 中途弹确认）"
[ "${HERDR_ENV:-}" = "1" ] || FAIL "环境门: HERDR_ENV 未设为 1（不在 herdr pane 内）"
herdr status 2>/dev/null | grep -q "status: running" || FAIL "环境门: herdr status 无 \"status: running\"（herdr 未运行）"
OK "环境门: MANA_AUTONOMOUS=1, HERDR_ENV=1, herdr running"

# ── b. pi 解析门 ─────────────────────────────────────────────────────────────
# 非交互 shell 里 `pi` 报 "error: command not found: exec"（交互 shell 的 function 不可用，
# PATH 上的 pi 脚本直跑也踩坑）→ 解析真实入口，#!/usr/bin/env node 头就用 node 调。
# 非交互 shell（herdr pane 内编排器/后台）PATH 可能缺 nvm bin → command -v 失败时兜底扫 nvm。
PI_BIN="$(command -v pi || ls -t "$HOME"/.nvm/versions/node/*/bin/pi 2>/dev/null | head -1)"
[ -n "$PI_BIN" ] || FAIL "pi 解析门: PATH 及 ~/.nvm/*/bin 都找不到 pi"
PI_REAL="$(readlink -f "$PI_BIN")"
if head -1 "$PI_REAL" | grep -q '^#!.*node'; then
  PI_RUN=(node "$PI_REAL")
else
  PI_RUN=("$PI_REAL")
fi
# 所有 pi 调用统一：timeout 兼子进程握管道陷阱——写临时文件再读，不搞命令替换直连管道。
VER_TMP="$(mktemp)"; timeout -k 5 30 "${PI_RUN[@]}" --version >"$VER_TMP" 2>/dev/null || true
PI_VERSION="$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+' "$VER_TMP" | head -1)"; rm -f "$VER_TMP"
[ -n "$PI_VERSION" ] || FAIL "pi 解析门: pi --version 无 semver 输出（PI_REAL=$PI_REAL）"
LOWEST="$(printf '%s\n0.84.0\n' "$PI_VERSION" | sort -V | head -1)"
[ "$LOWEST" = "0.84.0" ] || FAIL "pi 解析门: pi 版本 $PI_VERSION < 0.84，请升级 pi"
HELP_TMP="$(mktemp)"; timeout -k 5 30 "${PI_RUN[@]}" --help >"$HELP_TMP" 2>/dev/null || true
grep -q -- --exclude-tools "$HELP_TMP" \
  || FAIL "pi 解析门: pi $PI_VERSION 的 --help 不含 --exclude-tools（pi 过旧，请升级；降级方案：派发改用 --tools 白名单）"
rm -f "$HELP_TMP"
OK "pi 解析门: $PI_REAL ($PI_VERSION, --exclude-tools 可用)"

# ── c. 线路门 ────────────────────────────────────────────────────────────────
SETTINGS="$HOME/.pi/agent/settings.json"
WORKER_MODEL="$(jq -r 'if has("defaultProvider") and has("defaultModel") then .defaultProvider+"/"+.defaultModel else empty end' "$SETTINGS" 2>/dev/null)" \
  || FAIL "线路门: $SETTINGS 读取失败（文件缺失或非 JSON）"
[ -n "$WORKER_MODEL" ] || FAIL "线路门: $SETTINGS 缺 defaultProvider/defaultModel（worker_model 不得猜）"
OK "线路门: 默认线 $WORKER_MODEL"

if [ "${MANA_PREFLIGHT_SKIP_SMOKE:-}" = "1" ]; then
  WARN "线路门: pi -p 冒烟已跳过（MANA_PREFLIGHT_SKIP_SMOKE=1，仅供阴性测试）"
else
  # 判活只能用 -p 冒烟，不能拿 --list-models 目录匹配：目录不全、provider/model 分列都会骗过 grep。
  # ponytail: pi 0.99.1 实测应答 OK 后进程可挂住不退出（rc=124），故按应答内容判活，rc 作辅助；
  # 阴性对照（坏线路）0.7s 快速失败且无 OK 输出，仍走 FAIL。
  # ponytail: $(timeout … pi …) 会死等——timeout 杀主进程后子进程仍握住 stdout 管道，命令替换等不到 EOF；
  # 改写临时文件再读，timeout 返回即可取快照。
  SMOKE_TMP="$(mktemp)"; trap 'rm -f "$SMOKE_TMP"' EXIT
  timeout -k 15 240 "${PI_RUN[@]}" -p '只回答OK' >"$SMOKE_TMP" 2>&1
  SMOKE_RC=$?
  SMOKE_OUT="$(cat "$SMOKE_TMP")"
  if [ "$SMOKE_RC" -eq 0 ] || { [ "$SMOKE_RC" -eq 124 ] && grep -q 'OK' <<<"$SMOKE_OUT"; }; then
    [ "$SMOKE_RC" -eq 0 ] || WARN "线路门: pi -p 已应答 OK 但进程 240s 未退出（pi 收尾挂起，判活按应答计）"
    OK "线路门: pi -p 冒烟应答（默认线 $WORKER_MODEL）"
  else
    FAIL "线路门: pi -p 冒烟 rc=$SMOKE_RC（默认线 $WORKER_MODEL；快速失败多为线路/包名问题，对照 docs/providers.md）。stderr 末行: $(printf '%s' "$SMOKE_OUT" | tail -1)"
  fi
fi
LIST_TMP="$(mktemp)"
timeout -k 10 120 "${PI_RUN[@]}" --list-models >"$LIST_TMP" 2>/dev/null || true
LIST_OUT="$(cat "$LIST_TMP")"; rm -f "$LIST_TMP"
PROVIDER="${WORKER_MODEL%%/*}"; MODEL="${WORKER_MODEL#*/}"
if ! grep -qF -- "$PROVIDER" <<<"$LIST_OUT" && ! grep -qF -- "$MODEL" <<<"$LIST_OUT"; then
  WARN "线路门: --list-models 目录未见默认线 $WORKER_MODEL（目录不全/分列属已知假阴性，仅告警）"
fi

# ── d. 自检门（全部从 repo 根实跑） ─────────────────────────────────────────
SELFTESTS=(
  "PI_MANA_WORKER_SELFTEST=1 bun extensions/pi/mana-worker.ts"
  "PI_SAFE_GUARD_SELFTEST=1 bun extensions/pi/safe-guard.ts"
  "PI_PRECOMMIT_SELFTEST=1 bun extensions/pi/precommit-review.ts"
  "PI_MANA_WORKER_COMPACT_SELFTEST=1 bun extensions/pi/mana-worker-compact.ts"
  "MANA_COMPACT_SELFTEST=1 bun extensions/mana-compact.ts"
  "bun checks/safe-guard.check.mjs"
)
for t in "${SELFTESTS[@]}"; do
  # -u MANA_WORKER：precommit-review 自检的 decideCommit 默认参读 env，工人 pane 里跑会自证失败；
  # 预检验证的是扩展逻辑本身，剥掉 pane 的工人态。
  (cd "$REPO_ROOT" && env -u MANA_WORKER bash -c "$t") >/dev/null 2>&1 || FAIL "自检门: $t 非 0（在 $REPO_ROOT 实跑失败）"
  OK "自检门: $t"
done

# ── e. 装机门（存在性=硬失败；cmp 漂移=WARN，功能一致性以自检实跑为门） ──────
PI_EXT="$HOME/.pi/agent/extensions"
OMP_EXT="$HOME/.omp/agent/extensions"
PI_INSTALLED=()
for f in mana-worker.ts safe-guard.ts precommit-review.ts mana-worker-compact.ts; do
  [ -f "$PI_EXT/$f" ] || FAIL "装机门: 缺 $PI_EXT/$f（cp $REPO_ROOT/extensions/pi/*.ts $PI_EXT/）"
  PI_INSTALLED+=("$PI_EXT/$f")
done
OMP_INSTALLED=()
for f in mana-compact.ts safe-guard.ts; do
  [ -f "$OMP_EXT/$f" ] || FAIL "装机门: 缺 $OMP_EXT/$f（cp $REPO_ROOT/extensions/$f $OMP_EXT/）"
  OMP_INSTALLED+=("$OMP_EXT/$f")
done
OK "装机门: 6 个扩展文件存在（$PI_EXT, $OMP_EXT）"
for f in mana-worker.ts mana-worker-compact.ts precommit-review.ts; do
  cmp -s "$REPO_ROOT/extensions/pi/$f" "$PI_EXT/$f" || WARN "装机门: 漂移 $PI_EXT/$f 与 repo 版不同（功能以自检实跑为准）"
done
cmp -s "$REPO_ROOT/extensions/mana-compact.ts" "$OMP_EXT/mana-compact.ts" || WARN "装机门: 漂移 $OMP_EXT/mana-compact.ts 与 repo 版不同（功能以自检实跑为准）"
cmp -s "$REPO_ROOT/extensions/pi/safe-guard.ts" "$PI_EXT/safe-guard.ts" || WARN "装机门: 漂移 $PI_EXT/safe-guard.ts 与 repo 版不同（功能以自检实跑为准）"
cmp -s "$REPO_ROOT/extensions/safe-guard.ts" "$OMP_EXT/safe-guard.ts" || WARN "装机门: 漂移 $OMP_EXT/safe-guard.ts 与 repo 版不同（功能以自检实跑为准）"

# ── f. pig 门（pig 为可选工人线路：未装=SKIP 不拦；装了=扩展在位+自检绿，缺一即 FAIL） ──
# 为什么「未装 pig」不拦：pig 线路是可选工人线路，没装 pig 的机器 /mana run 照常只用 pi 工人跑完；
# 若在这里 FAIL 会把无 pig 机器挡死在预检。装了 pig 才要求扩展装机与自检（与装机门同语义）。
# 扩展路径沿装机门的用户级惯例，并尊重 pig 官方 PIG_HOME 覆盖（也供阴性测试注入三态）。
if command -v pig >/dev/null 2>&1; then
  PIG_EXT="${PIG_HOME:-$HOME/.pig}/agent/extensions/herdr-agent-state.ts"
  PIG_EXT_DIR="$(dirname "$PIG_EXT")"
  [ -f "$PIG_EXT" ] || FAIL "pig 门: 缺 $PIG_EXT（cp $REPO_ROOT/extensions/pig/herdr-agent-state.ts $PIG_EXT_DIR/）"
  if command -v node >/dev/null 2>&1; then
    # 自检走扩展入口 reportArgs()，断言两条：
    # ① --source=pig:herdr-state 与 --agent-session-path 在位：herdr 按 source 去重/归属集成，按 session path 关联会话文件，缺任一则上报对不上账；
    # ② --seq 严格单调递增：herdr 丢弃不高于已收序号的报告（见扩展内注释），seq 不涨则后续状态上报会被静默吞掉。
    PIG_CHK_TMP="$(mktemp)"
    HERDR_ENV=1 HERDR_PANE_ID=w1P:pZ HERDR_BIN_PATH=/bin/true PIG_EXT_PATH="$PIG_EXT" timeout -k 5 30 node --input-type=module -e "import assert from 'node:assert'; const m = await import(process.env.PIG_EXT_PATH); const a = m.reportArgs('idle',{path:'/s.jsonl'}); assert(a.includes('--source') && a.includes('pig:herdr-state') && a.includes('--agent-session-path')); const b = m.reportArgs('working'); assert(Number(b[b.indexOf('--seq')+1]) > Number(a[a.indexOf('--seq')+1]));" >"$PIG_CHK_TMP" 2>&1
    PIG_CHK_RC=$?
    if [ "$PIG_CHK_RC" -eq 0 ]; then
      OK "pig 门: herdr-agent-state.ts 在位且 reportArgs 自检绿（$PIG_EXT）"
    else
      FAIL "pig 门: 扩展自检 rc=$PIG_CHK_RC（stderr 末行: $(tail -1 "$PIG_CHK_TMP")）"
    fi
    rm -f "$PIG_CHK_TMP"
  else
    # node 缺失按 WARN+SKIP：pig 自身不依赖 node，无 node 的异常机器不该由 pig 门拦死主线路。
    WARN "pig 门: pig 在位但 node 缺失，reportArgs 自检无法执行，SKIP（pig 自身不依赖 node，不由此拦主线路）"
    OK "pig 门: SKIP 自检（node 缺失，扩展装机已在位）"
  fi
else
  OK "pig 门: SKIP pig 未安装（pig 为可选工人线路）"
fi

# ── g. 配置门 ────────────────────────────────────────────────────────────────
ASK_TMP="$(mktemp)"; timeout -k 5 30 omp config get ask.timeout >"$ASK_TMP" 2>/dev/null || true
ASK_TIMEOUT="$(cat "$ASK_TMP")"; rm -f "$ASK_TMP"
case "$ASK_TIMEOUT" in ''|*[!0-9]*) FAIL "配置门: omp config get ask.timeout 非 ≥1 整数（got: '$ASK_TIMEOUT'，orchestrator 自决兜底依赖它）";; esac
[ "$ASK_TIMEOUT" -gt 0 ] || FAIL "配置门: ask.timeout=$ASK_TIMEOUT 须 > 0（orchestrator 自决兜底依赖它）"
OK "配置门: ask.timeout=$ASK_TIMEOUT"

echo "PREFLIGHT PASS: worker_model=$WORKER_MODEL pi=$PI_VERSION"
exit 0
