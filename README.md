# Mana — OMP + Herdr + Pi 自主编排

**中文为主 · English below.**

Mana 是一个 OMP（oh-my-pi）技能：把一个 OMP session 变成 **orchestrator（编排者）**，把模糊目标收敛为可验收的 Issue，再在 CTO 一次授权下，调度 [herdr](https://herdr.dev) 专属 pane 里的 **Pi** 编码工人完成 `dispatch → supervise → verify → land → reclaim` 全流程，自主落地 PR、等 CI、合并、清理。

与 [herdr-dispatch](https://github.com/bestony/herdr-dispatch) 同思路、不同宿主：**Mana 严格面向 OMP + Pi 用户，不兼容其它 agent 宿主**，因此不存在多 dispatcher 分叉——只有一条经过生产验证的路径。

## 核心设计（为什么它能在无人值守下跑完）

1. **state 是唯一事实源**：每个 run 的全部状态在 `<repo>/.mana/<run-id>/state.json`，会话记忆不可信。
2. **DONE 是 claim 不是 verdict**：工人报完成后，orchestrator 亲自重跑验收命令才信。
3. **lane 永不 push/merge**：发布权只在 orchestrator，工人在隔离 worktree 里干活。
4. **tier 由机器判定**：CTO 一次写入 `tier_grants`（路径 glob + 可选 toml 键前缀 + 守卫命令），守卫 `exit 0` 即自主 landing；越界则预检就停，不"跑完再问"。
5. **工人必须回收**：验收后关闭专属 pane，agent/pane 双 `not_found` 才算完成。
6. **两端都不停在选择上**：工人侧 `MANA_WORKER=1` 关掉 pane 内全部交互门（提问、危险命令确认、pre-commit 审查），orchestrator 侧规则自决 + `ask` 超时兜底；等待人类的 UI 在无人的 pane 里等于死锁。

## 仓库结构

```
skills/mana/SKILL.md          # 技能本体：§0 不变量 + intake/context/run/dispatch/监督/landing/报告
extensions/safe-guard.ts      # OMP 扩展：危险命令确认 + MANA_AUTONOMOUS 自主开关 + 受保护路径
extensions/pi/mana-worker.ts  # Pi 扩展：MANA_WORKER=1 下封禁交互式提问（内联自检）
extensions/pi/safe-guard.ts   # Pi 扩展：MANA_WORKER=1 下危险命令只告警、受保护路径硬阻断
extensions/pi/precommit-review.ts  # Pi 扩展：MANA_WORKER=1 下关闭 pre-commit 审查门
checks/safe-guard.check.mjs   # OMP safe-guard 自检（5 组断言）
scripts/check-mana-grant-scope.py  # tier 授权守卫：路径 glob + toml 键前缀判定（--self-test 自带）
```

## 要求

| 组件 | 说明 |
|---|---|
| [OMP（oh-my-pi）](https://github.com/mariozechner/pi-coding-agent) | orchestrator 宿主；需启用技能与项目 `.pi` 发现 |
| [herdr](https://herdr.dev) | 创建 worktree / workspace / pane，`herdr agent start --kind pi` |
| Pi 编码 agent | lane 工人（`herdr agent start <name> --kind pi`） |
| 在一个 herdr pane 内运行 | 技能拒绝在 pane 外运行——没有可派发的目标 |
| git 仓库 | 从主 checkout 运行，不要在链接 worktree 里发起 run |
| `python3` | 守卫脚本与状态探测 |
| forge CLI（`gh`/`fj`/`glab` 任一） | 开 Issue、建 PR、merge；未装则 PR 命令打印出来由你执行 |

## 安装

### 1. 安装技能（项目级或全局）

```bash
# 项目级（推荐：随仓库共享给团队）
git clone https://github.com/chaos42dama/mana.git
mkdir -p .pi/skills
cp -r mana/skills/mana .pi/skills/mana

# 全局
mkdir -p ~/.omp/agent/skills
cp -r mana/skills/mana ~/.omp/agent/skills/mana
```

### 2. 安装 safe-guard 扩展

```bash
mkdir -p ~/.omp/agent/extensions
cp mana/extensions/safe-guard.ts ~/.omp/agent/extensions/safe-guard.ts
```

自检（需要 Bun）：

```bash
bun mana/checks/safe-guard.check.mjs
# ✓ safe-guard 自主模式校验通过（5 组断言）
```

### 3. 安装 tier 守卫到目标仓

```bash
mkdir -p scripts
cp mana/scripts/check-mana-grant-scope.py scripts/
python3 scripts/check-mana-grant-scope.py --self-test
# ✓ self-test ok
```

### 4. 安装工人侧（Pi）扩展

```bash
mkdir -p ~/.pi/agent/extensions
cp mana/extensions/pi/*.ts ~/.pi/agent/extensions/
```

自检（需要 Bun）：

```bash
PI_MANA_WORKER_SELFTEST=1 bun mana/extensions/pi/mana-worker.ts
PI_SAFE_GUARD_SELFTEST=1 bun mana/extensions/pi/safe-guard.ts
PI_PRECOMMIT_SELFTEST=1 bun mana/extensions/pi/precommit-review.ts
```

### 5. 开启自主模式（一次性授权）

```bash
export MANA_AUTONOMOUS=1      # 建议写进 ~/.bashrc
MANA_AUTONOMOUS=1 omp         # 自主 run 的启动形态
```

`MANA_AUTONOMOUS=1` 只跳过 bash 危险命令的确认弹窗（改为 warning 审计通知）；受保护路径（`.env`、`.git/`、`.ssh/`、`node_modules/`、`.omp/`）的确认与无 UI 时的硬阻断**不变**——密钥/认证红线不因自主模式放开。恢复逐条人工确认：`MANA_AUTONOMOUS=0 omp`。

## 使用

### 三个互斥入口

| 入口 | 用途 |
|---|---|
| `/mana <目标>` | **intake**：追问目标/非目标/验收/风险路径，收敛为可验收 Issue + 建议 `tier_grants`；不派发 |
| `/mana how/why/teach/recall <范围>` | **context**：只读上下文问答，不写代码 |
| `/mana run #<issue>` | **run**：唯一启动口令，默认即自主 landing（PR→CI→merge→清理）；`--manual-landing` 保留人工 merge 门 |

### 一次 run 的生命周期

1. **intake** 已产出 Issue：每个 lane 有目标、文件边界、可执行 acceptance、tier、建议 `tier_grants`。
2. CTO 一句 `/mana run #<issue>` 即为该 run 的一次性授权。
3. 预检（herdr/Pi/认证/CI/`MANA_AUTONOMOUS`/工人侧三扩展自检/tier 预测）→ 逐 lane `herdr worktree create`，并以 `--env MANA_WORKER=1` + `-- --exclude-tools ask_question` 派发。
4. 监督循环：重读 state → 探测工人 → `DONE` 后重跑 acceptance → 打回或 verified → 回收 pane。
5. landing：orchestrator push、建 PR、等 CI、merge 前复跑守卫，`exit 0` 才 squash merge，最后清理 worktree/branch 并关 Issue。

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

---

# Mana (English)

Mana is an OMP (oh-my-pi) skill that turns one OMP session into an **orchestrator**: it converges a fuzzy goal into an acceptable Issue, and — under one explicit authorization — dispatches **Pi** coding workers into dedicated [herdr](https://herdr.dev) panes to run the full `dispatch → supervise → verify → land → reclaim` cycle, landing PRs, waiting on CI, merging, and cleaning up.

Same idea as [herdr-dispatch](https://github.com/bestony/herdr-dispatch), different host: **Mana strictly targets OMP + Pi** and is not compatible with other agent hosts — so there are no multiple dispatchers, just one production-proven path.

## Why it survives unattended runs

1. **State is the only truth**: all run state lives in `<repo>/.mana/<run-id>/state.json`; conversation memory is never trusted.
2. **DONE is a claim, not a verdict**: the orchestrator re-runs acceptance criteria itself before believing a worker.
3. **Lanes never push or merge**: publishing stays with the orchestrator; workers are isolated in worktrees.
4. **Tier is machine-judged**: `tier_grants` (path globs + optional toml key prefixes + guard command); guard `exit 0` ⇒ autonomous landing, otherwise the run stops at preflight.
5. **Workers are always reclaimed**: after acceptance, the pane is closed and agent/pane must both report `not_found`.
6. **Neither end stalls on a choice**: worker-side `MANA_WORKER=1` shuts every interactive gate inside the pane (questions, dangerous-command confirmation, pre-commit review), orchestrator-side self-decides by rule with an `ask` timeout fallback; a human-waiting UI in an unmanned pane is a deadlock.

## Install

```bash
# 1. Skill (per-project, or into ~/.omp/agent/skills for global)
git clone https://github.com/chaos42dama/mana.git
mkdir -p .pi/skills && cp -r mana/skills/mana .pi/skills/mana

# 2. safe-guard extension
mkdir -p ~/.omp/agent/extensions
cp mana/extensions/safe-guard.ts ~/.omp/agent/extensions/safe-guard.ts
bun mana/checks/safe-guard.check.mjs

# 3. Tier guard into your repo
mkdir -p scripts
cp mana/scripts/check-mana-grant-scope.py scripts/
python3 scripts/check-mana-grant-scope.py --self-test

# 4. Worker-side (Pi) extensions
mkdir -p ~/.pi/agent/extensions
cp mana/extensions/pi/*.ts ~/.pi/agent/extensions/
PI_MANA_WORKER_SELFTEST=1 bun mana/extensions/pi/mana-worker.ts
PI_SAFE_GUARD_SELFTEST=1 bun mana/extensions/pi/safe-guard.ts
PI_PRECOMMIT_SELFTEST=1 bun mana/extensions/pi/precommit-review.ts

# 5. Autonomous mode (one-shot authorization)
export MANA_AUTONOMOUS=1
```

Requirements: OMP, [herdr](https://herdr.dev), a Pi coding agent with the worker extensions from `extensions/pi/` installed into `~/.pi/agent/extensions/`, run from inside a herdr pane in the main checkout of a git repo, `python3`, and any forge CLI (`gh`/`fj`/`glab`).

## Usage

- `/mana <goal>` — **intake**: clarify goal/non-goals/acceptance/risk paths into an acceptable Issue with suggested `tier_grants`; nothing is dispatched.
- `/mana how|why|teach|recall <scope>` — **context**: read-only Q&A.
- `/mana run #<issue>` — **run**: the only start phrase; autonomous landing is the default, `--manual-landing` keeps a human merge gate.

Invariants: never force-push, never touch resources it did not create, never approve a worker's push request, never merge with a failing guard, never report a half-finished lane as complete, never treat a human-waiting UI as control flow.

## License

MIT — see [LICENSE](LICENSE).
