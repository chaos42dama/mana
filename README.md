# Mana — OMP + Herdr + Pi 自主编排

**中文为主 · English below.**

Mana 是一个 OMP（oh-my-pi）技能：把一个 OMP session 变成 **orchestrator（编排者）**，把模糊目标收敛为可验收的 Issue，再在 CTO 一次授权下，调度 [herdr](https://herdr.dev) 专属 pane 里的 **Pi** 编码工人完成 `dispatch → supervise → verify → land → reclaim` 全流程，自主落地 PR、等 CI、合并、清理。

与 [herdr-dispatch](https://github.com/bestony/herdr-dispatch) 同思路、不同宿主：**Mana 严格面向 OMP + Pi 用户，不兼容其它 agent 宿主**，因此不存在多 dispatcher 分叉——只有一条经过生产验证的路径。

## 核心设计（为什么它能在无人值守下跑完）

1. **state 是唯一事实源**：每个 run 的全部状态在 `<repo>/.mana/<run-id>/state.json`，会话记忆不可信。
2. **DONE 是 claim 不是 verdict**：工人报完成后，orchestrator 亲自重跑验收命令才信。
3. **lane 永不 push/merge**：发布权只在 orchestrator，工人在隔离 worktree 里干活。orchestrator 的 push 也只针对本 run 自建分支、只追加 commit（永不 force-push）：每条 code lane 转 `verified` 后推一次 run 分支快照（供 `/mana resume` 对账），landing 时再 push；push 失败记 blocker 并在报告 Attention 段呈现，不阻断验收。
4. **tier 由机器判定**：CTO 一次写入 `tier_grants`（路径 glob + 可选 toml 键前缀 + 守卫命令），守卫 `exit 0` 即自主 landing；越界则预检就停，不"跑完再问"。
5. **工人必须回收**：验收后关闭专属 pane，agent/pane 双 `not_found` 才算完成。
6. **两端都不停在选择上**：工人侧 `MANA_WORKER=1` 关掉 pane 内全部交互门（提问、危险命令确认、pre-commit 审查），orchestrator 侧规则自决 + `ask` 超时兜底；等待人类的 UI 在无人的 pane 里等于死锁。
7. **验收结论绑定 commit**：每条 lane 验收时记 `head_sha` + `verdict`（`live|unit|type-only|blocked|failed`）；任何新 commit 作废旧结论，必须在新 SHA 上重跑验收。编排者自决轨迹与 `state.decision_log` 同源落 `.mana/<run-id>/decisions.tsv`（固定 6 列表头），最终报告设 `Attention` 段引出需人工注意的决策条目。
8. **失败重试与预算成文**：每条 lane 带 `max_wall_minutes`（默认 30）、`max_rounds`（默认 2，即「同一 lane 最多 2 轮」）与 `retry_mode`（`network|context-overflow|tool-error|none`），run 级 `max_parallel_lanes`（默认 2）只计 running 的 code lane。墙钟超时先取证再裁决，不等于失败；`tool-error` 记 blocker，不自动换线。
9. **交付洁净契约**：工人输出 `DONE:` 前其 worktree 必须洁净（`git status --short` 为空）；纯格式化/工具自动改写必须与成果一并 commit，不得静默丢弃。编排者绑 `head_sha` 前先查工作树，脏则不判 `verified`，处置（让工人 commit，或明确丢弃并记 `decision_log`）后重验。

## 仓库结构

```
skills/mana/SKILL.md          # 技能本体：§0 不变量 + intake/context/run/dispatch/监督/landing/报告
extensions/safe-guard.ts      # OMP 扩展：危险命令确认 + MANA_AUTONOMOUS 自主开关 + 受保护路径
extensions/mana-compact.ts    # OMP 扩展：session.compacting 注入 §0 不变量 + run 快照（内联自检）
extensions/pi/mana-worker.ts  # Pi 扩展：MANA_WORKER=1 下封禁交互式提问（内联自检）
extensions/pi/mana-worker-compact.ts  # Pi 扩展：MANA_WORKER=1 下接管 session_before_compact 保真 brief（内联自检）
extensions/pi/safe-guard.ts   # Pi 扩展：MANA_WORKER=1 下危险命令只告警、受保护路径硬阻断
extensions/pi/precommit-review.ts  # Pi 扩展：MANA_WORKER=1 下关闭 pre-commit 审查门
checks/safe-guard.check.mjs   # OMP safe-guard 自检（5 组断言）
checks/mana-verdict-ledger.check.mjs  # 验证账本契约自检：head_sha/verdict/decisions.tsv/失效规则（--self-test 跑合成 drill）
checks/mana-orchestrator-contract.check.mjs  # 编排者侧契约自检：herdr CLI 形态/超时≠未投递/不锁线/交付洁净/回收双验证（--self-test 跑合成残缺负例）
scripts/check-mana-grant-scope.py  # tier 授权守卫：路径 glob + toml 键前缀判定（--self-test 自带）
scripts/check-mana-issue.py        # intake Issue 骨架校验：6 段缺项即非 0，run 前自证（配套 test_check_mana_issue.py）
scripts/mana-run-lock.py           # run 单 owner 协作锁入口（flock + exec；7 组测试见 test_mana_run_lock.py）
scripts/mana-preflight.sh          # run 预检六门脚本（环境/pi 解析/线路/扩展自检/装机/配置；任一 FAIL 非 0 即停）
```

## 要求

| 组件 | 说明 |
| --- | --- |
| [OMP（oh-my-pi）](https://github.com/mariozechner/pi-coding-agent) | orchestrator 宿主；需启用技能与项目 `.pi` 发现 |
| [herdr](https://herdr.dev) | 创建 worktree / workspace / pane，`herdr agent start --kind pi` |
| Pi 编码 agent | lane 工人（`herdr agent start <name> --kind pi`） |
| 在一个 herdr pane 内运行 | 技能拒绝在 pane 外运行——没有可派发的目标 |
| git 仓库 | 从主 checkout 运行，不要在链接 worktree 里发起 run |
| `python3` | 守卫脚本与状态探测 |
| forge CLI（`gh`/`fj`/`glab` 任一） | 开 Issue、建 PR、merge；未装则 PR 命令打印出来由你执行 |
| 预检脚本 | Run 前跑 `bash scripts/mana-preflight.sh`（六门全过才派发；`MANA_PREFLIGHT_SKIP_SMOKE=1` 可跳线路冒烟） |

## 安装

**仓库正本 = 唯一事实源；用户级目录（`~/.omp/agent/skills`、`~/.omp/agent/extensions`、`~/.pi/agent/extensions`、`~/.agents/skills`）是安装产物**，由脚本覆盖，不要手改。

```bash
# 安装/修复（幂等：内容相同不写，不动 mtime）
bash scripts/mana-install.sh
# 只比对不写；任一目标漂移则 exit 1
bash scripts/mana-install.sh --check
# 看将做什么，不写
bash scripts/mana-install.sh --dry-run
```

脚本只复制下表列出的文件（`cmp -s` 判定，与 `scripts/mana-preflight.sh` 装机门同口径），绝不触碰 `settings.json` / `models.json` / `auth.json` / `~/.omp/agent/config.yml` 等配置与密钥：

| 仓库正本 | 目标 |
| --- | --- |
| `skills/mana/SKILL.md` | `~/.omp/agent/skills/mana/SKILL.md` |
| `skills/mana/SKILL.md` | `~/.agents/skills/mana/SKILL.md`（父目录存在时） |
| `extensions/pi/*.ts` | `~/.pi/agent/extensions/` |
| `extensions/safe-guard.ts`、`extensions/mana-compact.ts` | `~/.omp/agent/extensions/` |

自检（需要 Bun）：

```bash
node checks/mana-install.check.mjs --self-test
node checks/safe-guard.check.mjs
# ✓ safe-guard 自主模式校验通过（5 组断言）
PI_MANA_WORKER_SELFTEST=1 bun extensions/pi/mana-worker.ts
PI_SAFE_GUARD_SELFTEST=1 bun extensions/pi/safe-guard.ts
PI_PRECOMMIT_SELFTEST=1 bun extensions/pi/precommit-review.ts
PI_MANA_WORKER_COMPACT_SELFTEST=1 bun extensions/pi/mana-worker-compact.ts
MANA_COMPACT_SELFTEST=1 bun extensions/mana-compact.ts
```

### 安装 tier 守卫与 run 锁到目标仓

```bash
mkdir -p scripts
cp mana/scripts/check-mana-grant-scope.py scripts/
cp mana/scripts/mana-run-lock.py scripts/
python3 scripts/check-mana-grant-scope.py --self-test
# ✓ self-test ok

# run 锁自检（可选）
python3 scripts/test_mana_run_lock.py
# Ran 7 tests ... OK
```

pig 宿主另装 herdr 状态自报扩展：`mkdir -p ~/.pig/agent/extensions && cp mana/extensions/pig/*.ts ~/.pig/agent/extensions/`（见 `extensions/pig/README.md`）。

### 开启自主模式（一次性授权）

```bash
export MANA_AUTONOMOUS=1      # 建议写进 ~/.bashrc
MANA_AUTONOMOUS=1 omp         # 自主 run 的启动形态
```

`MANA_AUTONOMOUS=1` 只跳过 bash 危险命令的确认弹窗（改为 warning 审计通知）；受保护路径（`.env`、`.git/`、`.ssh/`、`node_modules/`、`.omp/`）的确认与无 UI 时的硬阻断**不变**——密钥/认证红线不因自主模式放开。恢复逐条人工确认：`MANA_AUTONOMOUS=0 omp`。

## 使用

### 三个互斥入口

| 入口 | 用途 |
| --- | --- |
| `/mana <目标>` | **intake**：追问目标/非目标/验收/风险路径，收敛为可验收 Issue + 建议 `tier_grants`；不派发。Issue 定稿先过 `python3 scripts/check-mana-issue.py` 骨架校验，`exit 0` 才可进 run |
| `/mana how/why/teach/recall/echo <范围>` | **context**：只读上下文问答，不写代码；`/mana echo` 另做目标对齐自检 |
| `/mana run #<issue>` | **run**：唯一启动口令，默认即自主 landing（PR→CI→merge→清理）；`--manual-landing` 保留人工 merge 门 |

> `/mana run` 有前置：目标仓须逐项满足技能的「仓库前置条件」节（`scripts/mana-run-lock.py`、tier 守卫、`.git/info/exclude`、仓内红线定义、`tier_grants` 批准、工具链）。缺项只走 context/intake。

### 一次 run 的生命周期

1. **intake** 已产出 Issue：每个 lane 有目标、文件边界、可执行 acceptance、tier、建议 `tier_grants`。
2. CTO 一句 `/mana run #<issue>` 即为该 run 的一次性授权。
3. 预检（herdr/Pi/认证/CI/`MANA_AUTONOMOUS`/工人侧三扩展自检/tier 预测；`state.worker_model` 记一次 `jq -r '.defaultProvider + "/" + .defaultModel' ~/.pi/agent/settings.json`，仅记录不派发）→ 逐 lane `herdr worktree create`，`herdr agent start ... -- --exclude-tools ask_question` **不传 `--model`**：工人启动时按 pi 当前默认直接使用；启动后 `herdr agent get` 回读会话 jsonl 首条 `model_change`，实测 `provider/modelId` 写入 `state.lanes[].model` 取证。
4. 监督循环：每轮 sweep 先「三读」——重读 state → 从 `origin/main` 重读技能正本比对 hash（漂移记 `drift` 并**按主干版继续**，不静默沿用旧版；每轮把 `drift_checked_at` 写回 state）→ 收 lane 事件。OMP goal runtime 仅为便利层，`state.json` + `scripts/mana-heartbeat.sh` 心跳是唯一权威续航。之后探测工人 → `DONE` 后先查工作树（`git status --short` 非空则不绑 `head_sha`、不判 `verified`，先让工人 commit 或明确丢弃并记 `decision_log`，处置完再重跑 acceptance）→ 打回或 verified（每 lane 记 `head_sha` + `verdict`，新 commit 作废旧结论；重投按 `retry_mode` 分类：`network` 原样重投不计数、`context-overflow` 缩小文件边界、`tool-error` 记 blocker 不换线；超 `max_wall_minutes` 先取证再裁决，不直接判失败）→ 回收 pane。打回/重派按 `attempt` 走：第 1 轮可同 pane `herdr agent prompt`；第 2 轮（唯一一次重派）必须先回收旧 pane（`close` + agent/pane 双 `not_found`）再新建 pane + 新 agent（仍不传 `--model`），且一律投「合并 brief」——原始 brief 全文 + 历次后续指令 + 旧 agent 最终状态行与 head SHA + 验收失败实际输出；lane 记 `attempt` 与 `superseded_by_agent` 可对账。
5. landing：orchestrator push、建 PR（PR body 是固定简报模板：`## Why`/`## What changed`/`## Scope`/`## Tradeoffs`（可省）/`## Blast Radius`/`## Verification` 六段、全文 ≤约 40 行、squash commit body 即 PR body，`## Verification` 每条带验收命令 + 实际输出摘要 + 绑定 head SHA）、等 CI、merge 前复跑守卫，`exit 0` 才 squash merge，最后清理 worktree/branch 并关 Issue。

### tier_grants：机器可判定的授权

```json
[
  {
    "scope": "前端文案配置化",
    "patterns": ["apps/web/", "ops/config/copy.*.toml"],
    "max_tier": "A",
    "guard": "python3 scripts/check-mana-grant-scope.py --base origin/main --allow-path apps/web/ --allow-path 'ops/config/copy.*.toml' --allow-key ui.txt.",
    "approved_at": "2026-09-16"
  }
]
```

- pattern 以 `/` 结尾授权整棵子树；toml 授权必须同时给 `--allow-key` 键前缀（只授权文案键，不授权开关/门禁键）。
- 密钥、认证、支付、非本 run 资源、main/DBA 重写**始终不在授权范围**，任何 grant 都不得覆盖。

## 它不会做什么（不变量，非默认值）

- 永不 force-push，永不 push 基线分支，永不 push state 之外的分支。
- 永不碰非本 run 创建的分支/worktree/会话。
- 工人请求 push/PR 一律上报，绝不批准。
- 守卫 `exit 0` 之前绝不合并。
- 绝不把半成品 lane 报告为完成。
- 永不把等待人类的 UI 当控制流：pane 内出现确认框即视为配置漂移，先查因，不靠 `send-keys` 顶过去。
- 不在派发参数锁死模型：工人启动按 pi 当前默认起步，orchestrator 启动后回读 session 实际线路取证；run 中途出现新 `model_change` 如实记录上报。

---

# Mana (English)

Mana is an OMP (oh-my-pi) skill that turns one OMP session into an **orchestrator**: it converges a fuzzy goal into an acceptable Issue, and — under one explicit authorization — dispatches **Pi** coding workers into dedicated [herdr](https://herdr.dev) panes to run the full `dispatch → supervise → verify → land → reclaim` cycle, landing PRs, waiting on CI, merging, and cleaning up.

Same idea as [herdr-dispatch](https://github.com/bestony/herdr-dispatch), different host: **Mana strictly targets OMP + Pi** and is not compatible with other agent hosts — so there are no multiple dispatchers, just one production-proven path.

## Why it survives unattended runs

1. **State is the only truth**: all run state lives in `<repo>/.mana/<run-id>/state.json`; conversation memory is never trusted. The OMP goal runtime is a convenience layer only — `state.json` plus the `scripts/mana-heartbeat.sh` heartbeat is the sole authoritative continuation; losing the goal tool never stops a run.
2. **DONE is a claim, not a verdict**: the orchestrator re-runs acceptance criteria itself before believing a worker.
3. **Lanes never push or merge**: publishing stays with the orchestrator; workers are isolated in worktrees. Orchestrator pushes only this run's own branches, append-only (never force-push): one run-branch snapshot push after each code lane turns `verified` (for `/mana resume` audit), plus the landing push; a failed push is recorded as a blocker in the report's Attention section and never blocks acceptance.
4. **Tier is machine-judged**: `tier_grants` (path globs + optional toml key prefixes + guard command); guard `exit 0` ⇒ autonomous landing, otherwise the run stops at preflight.
5. **Workers are always reclaimed**: after acceptance, the pane is closed and agent/pane must both report `not_found`.
6. **Neither end stalls on a choice**: worker-side `MANA_WORKER=1` shuts every interactive gate inside the pane (questions, dangerous-command confirmation, pre-commit review), orchestrator-side self-decides by rule with an `ask` timeout fallback; a human-waiting UI in an unmanned pane is a deadlock.
7. **Verdicts bind to commits**: each lane records `head_sha` + `verdict` (`live|unit|type-only|blocked|failed`) at acceptance time; any new commit voids old verdicts until acceptance re-runs on the new SHA. Orchestrator decisions mirror `state.decision_log` into `.mana/<run-id>/decisions.tsv` (fixed 6-column header) and surface in the report's `Attention` section.
8. **Skill drift is checked, never silently inherited**: every sweep re-reads `skills/mana/SKILL.md` from `origin/main` and compares hashes; on mismatch it records `drift_checked_at` + `drift` in state and continues on the mainline version, listing it in the report.
9. **Redispatch always carries a merged brief**: round 1 may re-prompt the same pane; round 2 (the only redispatch) must retire the old pane (`close` + double `not_found`), start a fresh agent, and deliver a merged brief — original brief in full, every follow-up instruction, the old agent's final status line and head SHA, and the actual failing acceptance output. Lanes record `attempt` and `superseded_by_agent` for audit.
10. **Retries and budgets are codified**: each lane carries `max_wall_minutes` (default 30), `max_rounds` (default 2 — the same "at most 2 rounds per lane" rule that `attempt` also caps), and `retry_mode` (`network|context-overflow|tool-error|none`); run-level `max_parallel_lanes` (default 2) counts only running code lanes. A wall-clock overrun means "collect evidence first", never an automatic failure; `tool-error` records a blocker and never switches the model route.
11. **Delivery hygiene is contractual**: a worker's worktree must be clean (`git status --short` empty) before it may print `DONE:`; pure formatting or tool auto-edits must be committed together with the deliverable, never silently dropped. Before binding `head_sha` the orchestrator checks the worktree — a dirty tree means no `verified` until the worker commits or the orchestrator discards explicitly and logs it in `decision_log`.

## Install

**The repo checkout is the single source of truth; the user-level dirs (`~/.omp/agent/skills`, `~/.omp/agent/extensions`, `~/.pi/agent/extensions`, `~/.agents/skills`) are install artifacts** — always installed by the script, never hand-edited.

```bash
# Install / repair (idempotent: identical content is not rewritten)
bash scripts/mana-install.sh
# Compare only; any drift exits 1
bash scripts/mana-install.sh --check
# Preview actions without writing
bash scripts/mana-install.sh --dry-run

# Tier guard + run lock into your repo
mkdir -p scripts
cp mana/scripts/check-mana-grant-scope.py scripts/
cp mana/scripts/mana-run-lock.py scripts/
python3 scripts/check-mana-grant-scope.py --self-test
python3 scripts/test_mana_run_lock.py   # optional: 7 lock tests
# pig host: pig-side herdr state extension
mkdir -p ~/.pig/agent/extensions && cp mana/extensions/pig/*.ts ~/.pig/agent/extensions/  # see extensions/pig/README.md
# Autonomous mode (one-shot authorization)
export MANA_AUTONOMOUS=1
```

Requirements: OMP, [herdr](https://herdr.dev), a Pi coding agent with the worker extensions from `extensions/pi/` installed into `~/.pi/agent/extensions/`, run from inside a herdr pane in the main checkout of a git repo, `python3`, and any forge CLI (`gh`/`fj`/`glab`).

## Usage

- `/mana <goal>` — **intake**: clarify goal/non-goals/acceptance/risk paths into an acceptable Issue with suggested `tier_grants`; nothing is dispatched.
- `/mana how|why|teach|recall|echo <scope>` — **context**: read-only Q&A; `/mana echo` additionally restates the current task goal so drift shows up immediately.
- `/mana run #<issue>` — **run**: the only start phrase; autonomous landing is the default, `--manual-landing` keeps a human merge gate.

`/mana run` has prerequisites: the target repo must satisfy the skill's repo-prerequisites checklist — `scripts/mana-run-lock.py`, the tier guard, `.git/info/exclude`, in-repo red-line definitions, an approved `tier_grants`, and the toolchain. Missing any of them means context/intake only.

Invariants: never force-push, never touch resources it did not create, never approve a worker's push request, never merge with a failing guard, never report a half-finished lane as complete, never treat a human-waiting UI as control flow, never pin a model in worker args: workers start on pi's current default route; the orchestrator reads the session's first `model_change` into state as evidence and reports any mid-run switch. Orchestrator pushes are limited to this run's own branches (verified-lane snapshots + landing push, append-only); PR bodies are fixed briefs — `## Why` / `## What changed` / `## Scope` / `## Tradeoffs` (omittable) / `## Blast Radius` / `## Verification`, at most ~40 lines, squash commit body = PR body, and every Verification item carries an acceptance command, actual output summary, and bound head SHA.

## License

MIT — see [LICENSE](LICENSE).
