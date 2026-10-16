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
10. **脏树处置可审计**：脏树按三步处置，取证缺失不得处置——① 取证：`git status --short` + `git diff` 原文（含 `git diff --stat` 汇总行）逐字进 `decision_log.evidence`；② 归类：(a) 纯格式化 / (b) 含语义改动，附依据 hunk；③ 处置：(a) commit（工人已收尾时编排者可代 commit 并标注）；(b) 禁止静默丢弃，打回不推进 `attempt`、不消耗 `max_rounds`，仍丢弃则列 `Attention`。

## 仓库结构

```
skills/mana/SKILL.md          # 技能本体：§0 不变量 + intake/context/run/dispatch/监督/landing/报告
extensions/safe-guard.ts      # OMP 扩展：危险命令确认 + MANA_AUTONOMOUS 自主开关 + 受保护路径
extensions/mana-compact.ts    # OMP 扩展：session.compacting 注入 §0 不变量 + run 快照（内联自检）
extensions/pi/mana-worker.ts  # Pi 扩展：MANA_WORKER=1 下封禁交互式提问（内联自检）
extensions/pi/mana-worker-compact.ts  # Pi 扩展：MANA_WORKER=1 下接管 session_before_compact 保真 brief（内联自检）
extensions/pi/safe-guard.ts   # Pi 扩展：MANA_WORKER=1 下危险命令只告警、受保护路径硬阻断
extensions/pi/precommit-review.ts  # Pi 扩展：MANA_WORKER=1 下关闭 pre-commit 审查门
checks/all.check.mjs          # 契约 check 聚合 runner：一条命令跑全部 *.check.mjs 两种模式（无参数 + --self-test）
checks/safe-guard.check.mjs   # OMP safe-guard 自检（5 组断言）
checks/mana-verdict-ledger.check.mjs  # 验证账本契约自检：head_sha/verdict/decisions.tsv/失效规则（--self-test 跑合成 drill）
checks/mana-orchestrator-contract.check.mjs  # 编排者侧契约自检：herdr CLI 形态/超时≠未投递/不锁线/交付洁净/回收双验证（--self-test 跑合成残缺负例）
scripts/check-mana-grant-scope.py  # 装机至 ~/.omp/agent/skills/mana/scripts/；tier 授权守卫（--self-test 自带）
scripts/check-mana-issue.py        # 装机至 `~/.omp/agent/skills/mana/scripts/`；intake Issue 骨架校验
scripts/mana-run-lock.py           # 装机至 `~/.omp/agent/skills/mana/scripts/`；run 单 owner 协作锁入口
scripts/mana-preflight.sh          # 装机至 `~/.omp/agent/skills/mana/scripts/`；run 预检七门（任一 FAIL 非 0 即停）
scripts/mana-selftest.sh           # 装机至 `~/.omp/agent/skills/mana/scripts/`；全仓自检入口（--list/--quick/--only）
scripts/test_mana_selftest.py      # 装机至 `~/.omp/agent/skills/mana/scripts/`；自检入口回归测试
```

## 要求

| 组件 | 说明 |
| --- | --- |
| [OMP（oh-my-pi）](https://github.com/can1357/oh-my-pi) | orchestrator 宿主；需启用技能与项目 `.pi` 发现 |
| [herdr](https://herdr.dev) | 创建 worktree / workspace / pane，`herdr agent start --kind pi` |
| [Pi 编码 agent](https://github.com/badlogic/pi-mono) | lane 工人（`herdr agent start <name> --kind pi`）；npm 包 `@earendil-works/pi-coding-agent` |
| 在一个 herdr pane 内运行 | 技能拒绝在 pane 外运行——没有可派发的目标 |
| git 仓库 | 从主 checkout 运行，不要在链接 worktree 里发起 run |
| `python3` | 守卫脚本与状态探测 |
| forge CLI（`gh`/`fj`/`glab` 任一） | 开 Issue、建 PR、merge；未装则 PR 命令打印出来由你执行 |
| 预检脚本 | Run 前跑 `bash ~/.omp/agent/skills/mana/scripts/mana-preflight.sh`（六门全过才派发；线路门对 `pi -p` 冒烟三态分类 healthy/capacity/unavailable，额度·速率·并发类失败单独报 capacity，并判定默认线漂移——`.mana/*/state.json` 的 `worker_model` ≠ 当前 settings 默认线即 FAIL，列 baseline/当前值取证；`MANA_PREFLIGHT_SKIP_SMOKE=1` 可跳线路冒烟） |

pig 是可选工人线路：装了 pig 的机器可把 lane 工人换成 pig——herdr 通过 pig 侧自报扩展感知其状态，该扩展与预检 pig 门由仓内 `extensions/pig/` 与全局 `~/.omp/agent/skills/mana/scripts/mana-preflight.sh` 保证；未装 pig 时只用 pi 工人，pig 门 SKIP 不拦。

## 安装

**仓库正本 = 唯一事实源；用户级目录（`~/.omp/agent/skills`、`~/.omp/agent/extensions`、`~/.pi/agent/extensions`、`~/.agents/skills`）是安装产物**，由脚本覆盖，不要手改。`~/.omp/agent/skills/mana/scripts/` 是全局 mana 脚本目录。

```bash
# 安装/修复（幂等：内容相同不写，不动 mtime）
bash scripts/mana-install.sh
# 只比对不写；任一目标漂移则 exit 1
bash scripts/mana-install.sh --check
# 看将做什么，不写
bash scripts/mana-install.sh --dry-run
```

脚本按下表同步两组安装产物：**正本仓布局镜像**供仓内契约检查与全仓自检，**技能根落位**供 OMP 加载技能及其 references。两组都由同一正本映射生成，不手抄副本；`cmp -s` 判定，与全局 `~/.omp/agent/skills/mana/scripts/mana-preflight.sh` 装机门同口径；目录内新增文件自动纳入，脚本保留正本执行位。映射源集、完整目标集、此表及 `git ls-files` 正本跟踪集由 `checks/mana-install.check.mjs` 机械断言；镜像集明确排除 `.gitignore`。不触碰 `settings.json` / `models.json` / `auth.json` / `~/.omp/agent/config.yml` 等配置与密钥：

**正本仓布局镜像**（保留仓内相对路径）：

| 仓库正本 | 目标 |
| --- | --- |
| `skills/mana/**` | `~/.omp/agent/skills/mana/skills/mana/**` |
| `scripts/**` | `~/.omp/agent/skills/mana/scripts/**` |
| `extensions/**` | `~/.omp/agent/skills/mana/extensions/**` |
| `checks/**` | `~/.omp/agent/skills/mana/checks/**` |
| `docs/**` | `~/.omp/agent/skills/mana/docs/**` |
| `README.md` | `~/.omp/agent/skills/mana/README.md` |
| `AGENTS.md` | `~/.omp/agent/skills/mana/AGENTS.md` |
| `LICENSE` | `~/.omp/agent/skills/mana/LICENSE` |

**技能根落位**（同一安装产物的额外目标）：

| 仓库正本 | 目标 |
| --- | --- |
| `skills/mana/SKILL.md` | `~/.omp/agent/skills/mana/SKILL.md` |
| `skills/mana/references/**` | `~/.omp/agent/skills/mana/references/**` |

**既有接线目录**（同一安装产物）：

| 仓库正本 | 目标 |
| --- | --- |
| `skills/mana/SKILL.md` | `~/.agents/skills/mana/SKILL.md`（父目录存在时） |
| `extensions/pi/mana-worker.ts` | `~/.pi/agent/extensions/mana-worker.ts` |
| `extensions/pi/mana-worker-compact.ts` | `~/.pi/agent/extensions/mana-worker-compact.ts` |
| `extensions/pi/precommit-review.ts` | `~/.pi/agent/extensions/precommit-review.ts` |
| `extensions/pi/safe-guard.ts` | `~/.pi/agent/extensions/safe-guard.ts` |
| `extensions/safe-guard.ts` | `~/.omp/agent/extensions/safe-guard.ts` |
| `extensions/mana-compact.ts` | `~/.omp/agent/extensions/mana-compact.ts` |
| `extensions/pig/herdr-agent-state.ts` | `~/.pig/agent/extensions/herdr-agent-state.ts`（父目录存在时） |

所有目标均由装机脚本从同一正本同步。

**预检源与目标仓**：`MANA_SRC` 指定扩展正本源，缺省按 `MANA_SRC` → 当前仓 `git-common-dir` 候选 → 完整镜像目录解析；镜像同时含 `extensions/` 与 `checks/` 时，它就是默认源，无需设置 `MANA_SRC`，预检会跑全装机门与 `mana-selftest.sh --quick`。镜像不完整时保留可见 `WARN`，降级为已安装扩展自检。`MANA_REPO` 指定 run-state 所属目标仓，缺省解析当前工作目录的 git 根。

自检（需要 Bun）：

```bash
bash scripts/mana-selftest.sh   # 全仓自检 10 步一条命令（契约 check + 守卫/run 锁/issue 自检与测试 + 五扩展内联自检）；
                               # --quick 只跑前 5 步（run 预检 d 门用这档）；--only <子串> 按步骤名单点排查；--list 只列步骤
node checks/all.check.mjs   # 一条命令跑全部契约 check 两种模式（无参数断言 + --self-test drill）；单点排查用 --only <子串>
# ✓ 逐项 ✓ …（共 2×N 行）末行 ALL-16-rc=0
PI_MANA_WORKER_SELFTEST=1 bun extensions/pi/mana-worker.ts
PI_SAFE_GUARD_SELFTEST=1 bun extensions/pi/safe-guard.ts
PI_PRECOMMIT_SELFTEST=1 bun extensions/pi/precommit-review.ts
PI_MANA_WORKER_COMPACT_SELFTEST=1 bun extensions/pi/mana-worker-compact.ts
MANA_COMPACT_SELFTEST=1 bun extensions/mana-compact.ts
```

### 安装全局脚本与 run 锁

脚本已由上面的 `bash scripts/mana-install.sh` 一次性装入 `~/.omp/agent/skills/mana/scripts/`，目标仓不再复制脚本。安装后直接运行：

```bash
python3 ~/.omp/agent/skills/mana/scripts/check-mana-grant-scope.py --self-test
# ✓ self-test ok

# run 锁自检（可选）
python3 ~/.omp/agent/skills/mana/scripts/test_mana_run_lock.py
# Ran 7 tests ... OK
```

pig 宿主的 herdr 状态自报扩展已纳入装机清单，不再手工 cp——见下节「pig 工人线路（可选）」（扩展背景见 `extensions/pig/README.md`）。

### pig 工人线路（可选）

**何时需要**：想让 `/mana run` 把 lane 工人换成 pig（而非默认 pi）时才装；只用 pi 工人的机器可整节跳过。

**安装（先装 pig，再跑装机脚本）**：先安装 pig 本体（产生 `~/.pig/agent/extensions/` 目录），再跑一次装机脚本，pig 侧扩展随之落位：

```bash
bash scripts/mana-install.sh
```

脚本的 cond 语义保证：`~/.pig/agent/extensions/` 不存在时该条目显示 `skip（父目录不存在）` 并继续，不报错。

**验证**：跑 `bash ~/.omp/agent/skills/mana/scripts/mana-preflight.sh`，看输出里 `pig 门:` 那一行——扩展在位且 `reportArgs()` 自检绿即 `ok`。注意：**preflight 只发现并报错，不负责安装**；发现缺失时回到上一条用装机脚本修复。

**未装 pig**：该门 SKIP 不拦，`/mana run` 照常只用 pi 工人跑完。

### 开启自主模式（一次性授权）

```bash
# 只在编排者 pane 生效（推荐）：
MANA_AUTONOMOUS=1 omp         # 自主 run 的启动形态
# 或在 herdr pane split 时带 env：
# herdr pane split --current --direction down --cwd <path> --env MANA_AUTONOMOUS=1 --no-focus
```

> **不要**把 `export MANA_AUTONOMOUS=1` 写进 `~/.bashrc`——这会让所有非 mana 的 omp 会话也跳过 safe-guard 的危险命令确认。只在编排者 pane 设置。

`MANA_AUTONOMOUS=1` 只跳过 bash 危险命令的确认弹窗（改为 warning 审计通知）；受保护路径（`.env`、`.git/`、`.ssh/`、`node_modules/`、`.omp/`）的确认与无 UI 时的硬阻断**不变**——密钥/认证红线不因自主模式放开。恢复逐条人工确认：`MANA_AUTONOMOUS=0 omp`。

## 使用

### 三个互斥入口

| 入口 | 用途 |
| --- | --- |
| `/mana <目标>` | **intake**：追问目标/非目标/验收/风险路径，收敛为可验收 Issue + 建议 `tier_grants`；不派发。Issue 定稿先过 `python3 ~/.omp/agent/skills/mana/scripts/check-mana-issue.py` 骨架校验，`exit 0` 才可进 run |
| `/mana how/why/teach/recall/echo <范围>` | **context**：只读上下文问答，不写代码；how/why 支持并行只读取证 lane（how：Complex 拆切面 ≤ `max_parallel_lanes`；why：代码锚点先行 + 每证据类别一条 investigator + 四档证据分级）；结论默认不落盘，仅在回复里交付，明确要求才写 `.mana/<context-id>/`；`/mana echo` 另做目标对齐自检 |
| `/mana architect <范围>` | **context**：只读多线路设计入口——2–3 条独立 sketch lane 交叉评审合成 design package，落盘 `.mana/<design-id>/`；不写实现代码、不 push/merge，实现归 `/mana run` |
| `/mana prototype <决策问题>` | **context**：只读原型入口——throwaway 多变体原型 + 一个 switcher + 观测量回答一个具体决策，落盘 `.mana/<probe-id>/`；原型永不进主干，不承诺自动截图（UI 类只到能渲染 + 人工看） |
| `/mana veri <目标>` | **context**：只读验证技能生成入口——init（五步访谈 → 生成 verify-<app> 技能 → 端到端实跑）/doctor/status 三口，永不改产品代码；maintain 例行对账（三结果 `clean|changed|blocked`，`--source-only` 只标 partial）；落盘/维护细节见技能 veri 条目 |
| `/mana run #<issue>` | **run**：唯一启动口令，默认即自主 landing（PR→CI→merge→清理）；`--manual-landing` 保留人工 merge 门 |

> `/mana run` 有前置：先由正本仓运行 `bash scripts/mana-install.sh` 装机，使全局 mana scripts/ 含 run-lock 与 tier guard；目标仓再满足其余「仓库前置条件」（`.git/info/exclude`、仓内红线定义、`tier_grants` 批准、工具链）。缺项只走 context/intake。

### 一次 run 的生命周期

1. **intake** 已产出 Issue：每个 lane 有目标、文件边界、可执行 acceptance、tier、建议 `tier_grants`。
2. CTO 一句 `/mana run #<issue>` 即为该 run 的一次性授权。
3. 预检（herdr/Pi/认证/CI/`MANA_AUTONOMOUS`/工人侧三扩展自检/tier 预测；`state.worker_model` 记一次 `jq -r '.defaultProvider + "/" + .defaultModel' ~/.pi/agent/settings.json`，仅记录不派发）→ 逐 lane `herdr worktree create`，`herdr agent start ... -- --exclude-tools ask_question` **不传 `--model`**：工人启动时按 pi 当前默认直接使用；启动后 `herdr agent get` 回读会话 jsonl 首条 `model_change`，实测 `provider/modelId` 写入 `state.lanes[].model` 取证。
4. 监督循环：每轮 sweep 先「三读」——重读 state → 从 `origin/main` 重读技能正本比对 hash（漂移记 `drift` 并**按主干版继续**，不静默沿用旧版；每轮把 `drift_checked_at` 写回 state）→ 收 lane 事件。OMP goal runtime 仅为便利层，`state.json` + `~/.omp/agent/skills/mana/scripts/mana-heartbeat.sh` 心跳是唯一权威续航。之后探测工人 → `DONE` 后先查工作树（`git status --short` 非空则不绑 `head_sha`、不判 `verified`，先让工人 commit 或明确丢弃并记 `decision_log`，处置完再重跑 acceptance）→ 打回或 verified（每 lane 记 `head_sha` + `verdict`，新 commit 作废旧结论；重投按 `retry_mode` 分类：`network` 原样重投不计数、`context-overflow` 缩小文件边界、`tool-error` 记 blocker 不换线；超 `max_wall_minutes` 先取证再裁决，不直接判失败）→ 回收 pane。打回/重派按 `attempt` 走：第 1 轮可同 pane `herdr agent prompt`；第 2 轮（唯一一次重派）必须先回收旧 pane（`close` + agent/pane 双 `not_found`）再新建 pane + 新 agent（仍不传 `--model`），且一律投「合并 brief」——原始 brief 全文 + 历次后续指令 + 旧 agent 最终状态行与 head SHA + 验收失败实际输出；lane 记 `attempt` 与 `superseded_by_agent` 可对账。
5. landing：orchestrator push、建 PR（PR body 是固定简报模板：`## Why`/`## What changed`/`## Scope`/`## Tradeoffs`（可省）/`## Blast Radius`/`## Verification` 六段、全文 ≤约 40 行、squash commit body 即 PR body，`## Verification` 每条带验收命令 + 实际输出摘要 + 绑定 head SHA）、等 CI、merge 前复跑守卫，`exit 0` 才 squash merge，最后清理 worktree/branch 并关 Issue。

### tier_grants：机器可判定的授权

```json
[
  {
    "scope": "前端文案配置化",
    "patterns": ["apps/web/", "ops/config/copy.*.toml"],
    "max_tier": "A",
    "guard": "python3 ~/.omp/agent/skills/mana/scripts/check-mana-grant-scope.py --base origin/main --allow-path apps/web/ --allow-path 'ops/config/copy.*.toml' --allow-key ui.txt.",
    "approved_at": "2026-09-16"
  }
]
```

- pattern 以 `/` 结尾授权整棵子树；toml 授权必须同时给 `--allow-key` 键前缀（只授权文案键，不授权开关/门禁键）。
- 密钥、认证、支付、非本 run 资源、main/DBA 重写**始终不在授权范围**，任何 grant 都不得覆盖。

## 最新关键指令（main 最新版）

### 四个互斥入口

| 指令 | 类型 | 用途 |
| --- | --- | --- |
| `/mana <目标>` | intake | 模糊目标 → 可验收 Issue |
| `/mana how <范围>` | context（只读） | 架构/数据流/文件归属；Complex 拆并行 explorer |
| `/mana why <范围>` | context（只读） | 「为什么长成这样」；代码锚点先行，按证据类别派 lane |
| `/mana teach <范围>` | context（只读） | 中文分层解释 |
| `/mana recall <主题>` | context（只读） | 回看七天会话记忆/state/Issue/PR/分支 |
| `/mana echo <问题 或 #N>` | context（只读） | 目标对齐自检 |
| `/mana architect <范围>` | context（只读） | 多线路只读设计：2–3 条独立 sketch → 交叉评审 → 合成 |
| `/mana prototype <决策问题>` | context（只读） | throwaway 多变体 + switcher，永不进主干 |
| `/mana veri <目标>` | context（只读） | 验证技能与功能地图四口：init / doctor / status / maintain（详见下节） |
| `/mana run #<issue>` | run | 授权后自主执行（默认自主 landing） |
| `/mana run #<issue> --manual-landing` | run | 保留人工 merge 门 |
| `/mana resume <run-id>` | resume | 崩溃/重启恢复 |

### `/mana veri`：验证技能与功能地图（核心原理与日常使用）

**核心原理**：mana 里每次 run 的验收都绑 lane 的 `head_sha`（§0「DONE 是 claim 不是 verdict」），但「这个仓的应用怎么启动、怎么驱动、怎么取证」的知识过去只活在每个 agent 的会话记忆里。`/mana veri` 把它固化成**项目级事实源**：`verify-<app>/SKILL.md`（Launch / Doctor / Drive / Evidence / Cleanup / Helpers 六节，全部写死真实命令与就绪信号，无占位符）+ 功能地图 `features/*`（每个功能四 H2 + front-matter 账本 `last_verified_sha`/`verdict`/`prerequisites`——证据绑 SHA，新 commit 即触发陈旧）。前置：`veri init` 交付前 must 端到端实跑（launch→doctor→drive 1 个 feature→取证→cleanup→证据仍在），未执行过的生成技能只是 draft。

**四口日常使用**：

| 子命令 | 什么时候用 | 产出 |
| --- | --- | --- |
| `veri init [<app>]` | 给新仓生成验证技能（一次） | `verify-<app>/` + 前 3–5 个 features（生成后 orchestrator 亲自端到端实跑一遍） |
| `veri doctor [<app>]` | 任意时刻只读零副作用；**重大功能变化后必跑** | 六节 Doctor + 功能地图索引卫生（README vs sibling 对账），不改文件 |
| `veri status` | 想知道既往验收是否还有效 | verify-* 清单：feature 数、各账本 SHA、落后 head/origin/main 的陈旧度 |
| `veri maintain [<app>]` | 有重大变更后或人工节奏到期；`--source-only` 快查不驱动 | Pass 0–6 对账 → `clean`（无 PR）/ `changed`（≤1 个 PR，只含已证实的修正）/ `blocked`（逐项写明）；`--source-only` 结果只标 `partial`，不得当作 clean |

**边界（对 pstack 原型的收束）**：maintain 的编辑范围只限 `verify-<app>/` 自身目录，**永不改产品代码**——行为与地图不符时要么是 doc drift（修地图）、要么是 product gap（写进报告上报），不用文档现状照盖；source wave 只读 lanes 走 `MANA_WORKER=1` 派发、不传 `--model`；live pass 由 orchestrator 独占驾驶。生成物 canonical = `~/.pi/agent/skills/verify-<app>/`，OMP 侧 `~/.omp/agent/skills/verify-<app>` 软链共用（#78 实测裁决：`~/.pi/skills/` 不被 pi 发现）；工人 lane 在目标仓 worktree `.pi/skills/` 生成，用户级安装归 landing 段（safe-guard 用户级硬拦，已在 #79/#80 两 run 实证）。

### 关键脚本

- `~/.omp/agent/skills/mana/scripts/mana-run-lock.py` — run 单 owner 持锁入口（`fcntl.flock`，竞争失败返回 73）
- `~/.omp/agent/skills/mana/scripts/check-mana-grant-scope.py` — tier 守卫（`--self-test` / `--paths` 预测 / `--base+--allow-key` 复核）
- `~/.omp/agent/skills/mana/scripts/mana-preflight.sh` — run 预检（环境/pi 解析/线路/装机/配置/扩展自检）
- `~/.omp/agent/skills/mana/scripts/mana-heartbeat.sh` — 心跳兜底（可 crontab 定时唤醒 sweep）
- `scripts/mana-install.sh` — 正本仓安装器（同步技能、references 与全局脚本）
- `~/.omp/agent/skills/mana/scripts/mana-selftest.sh` — 全仓自检（`--quick` 为预检 d 门回归面）
- `~/.omp/agent/skills/mana/scripts/check-mana-issue.py` — intake Issue 骨架校验（`exit 0` 才可授权）
- `node checks/all.check.mjs` — 契约回归面（全部 `checks/*.check.mjs` 无参数断言 + `--self-test` drill）

### 关键环境变量

- `MANA_AUTONOMOUS=1` — 编排者自主模式（safe-guard 跳过危险确认，改为 notify）
- `MANA_WORKER=1` — 工人模式（提问 block、危险 bash 只告警、review 整门关闭）

### 关键扩展（`extensions/pi/`）

- `mana-worker.ts` — 工人提问工具 block + 自决指令回灌
- `safe-guard.ts` — 危险 bash 只 notify；受保护路径硬 block
- `precommit-review.ts` — 整门关闭（工人 pane 无人类，`/review` 会死锁）
- `mana-worker-compact.ts` — 工人侧 compaction 接管（协议块+原始 brief+上次摘要写进压缩结果）
- `mana-compact.ts` — 编排者侧 compaction 注入（§0 不变量+lane 快照+下一步）

## 后续计划增强

### P2（Issue #13 跟踪）

- **how/why 并行 explorer 深化**：当前 how 的 Complex 路径已支持拆并行 lane，但 why 的 investigator lane 仍受 `max_parallel_lanes=2` 预算限制；评估提高默认预算或保持现状
- **recall 会话记忆检索增强**：当前 recall 回看七天会话记忆，考虑接入 codebase-memory MCP 或增加 `.mana/*/state.json` 自动摘要索引
- **arena 多模型竞技场**：若未来需要跨模型验证，可在 architect 阶段引入多线路 sketch 或在 verifier lane 中引入跨模型交叉评审
- **technical-writing/unslop**：若 README 驱动开发成为刚需，可在 intake 阶段增加「README 模板校验」

### 已评估不采纳（pstack 独有能力）

- per-role 模型路由（与不传 `--model` 策略相反）
- `/loop 1h` 取代 heartbeat（事件驱动更适合无人工 run）
- performance mantras（无 perf lane，纯文案压缩收益低于噪音）

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

1. **State is the only truth**: all run state lives in `<repo>/.mana/<run-id>/state.json`; conversation memory is never trusted. The OMP goal runtime is a convenience layer only — `state.json` plus the `~/.omp/agent/skills/mana/scripts/mana-heartbeat.sh` heartbeat is the sole authoritative continuation; losing the goal tool never stops a run.
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
12. **Dirty-tree handling is auditable**: three ordered steps, no evidence no disposition — ① evidence: `git status --short` + `git diff` verbatim (including the `git diff --stat` summary) into `decision_log.evidence`; ② classify: (a) formatting-only vs (b) semantic, with the supporting hunks; ③ dispose: (a) commit (the orchestrator may commit on the worker's behalf and must say so); (b) never silently dropped — sending it back consumes no `attempt`/`max_rounds`, and an actual discard must be listed in the report's `Attention` section.

## Install

**The repo checkout is the single source of truth; the user-level dirs (`~/.omp/agent/skills`, `~/.omp/agent/extensions`, `~/.pi/agent/extensions`, `~/.agents/skills`) are install artifacts** — always installed by the script, never hand-edited. `skills/mana/references/*.md` is distributed by the same script via glob expansion into `~/.omp/agent/skills/mana/references/` (#59): new reference files are picked up automatically, no file list to hand-maintain.

```bash
# Install / repair (idempotent: identical content is not rewritten)
bash scripts/mana-install.sh
# Compare only; any drift exits 1
bash scripts/mana-install.sh --check
# Preview actions without writing
bash scripts/mana-install.sh --dry-run

# Tier guard + run lock into your repo
mkdir -p scripts
python3 ~/.omp/agent/skills/mana/scripts/check-mana-grant-scope.py --self-test
python3 scripts/test_mana_run_lock.py   # optional: 7 lock tests
# pig host: pig-side herdr state extension rides the same install script (see "pig worker route (optional)" below)
bash scripts/mana-install.sh
# Autonomous mode (one-shot authorization) — set only in the orchestrator pane
MANA_AUTONOMOUS=1 omp
# Do NOT add `export MANA_AUTONOMOUS=1` to ~/.bashrc: it would disable safe-guard for all OMP sessions.
```

Requirements: [OMP](https://github.com/can1357/oh-my-pi), [herdr](https://herdr.dev), a [Pi coding agent](https://github.com/badlogic/pi-mono) (npm `@earendil-works/pi-coding-agent`) with the worker extensions from `extensions/pi/` installed into `~/.pi/agent/extensions/`, run from inside a herdr pane in the main checkout of a git repo, `python3`, and any forge CLI (`gh`/`fj`/`glab`). The preflight line gate classifies the `pi -p` smoke test three ways (healthy / capacity / unavailable — quota, rate and concurrency failures report `capacity` separately) and fails closed on default-route drift: a `.mana/*/state.json` `worker_model` differing from the current settings default fails the preflight with baseline/current-value evidence.

### pig worker route (optional)

**When you need it**: only when you want `/mana run` lanes to run on pig workers instead of the default pi workers. Skip this section on pi-only machines.

**Install (install pig first, then run the install script)**: install pig itself first (this creates `~/.pig/agent/extensions/`), then run `bash scripts/mana-install.sh` — the pig-side extension is installed along with everything else. The script's conditional semantics guarantee that a missing `~/.pig/agent/extensions/` shows `skip (parent dir absent)` and continues instead of erroring.

**Verify**: run `bash ~/.omp/agent/skills/mana/scripts/mana-preflight.sh` and look at the `pig 门:` line — `ok` means the extension is in place and its `reportArgs()` self-check is green. Note: **preflight only detects and reports, it never installs**; if it reports a missing extension, fix it with the install script above.

**Without pig**: the gate SKIPs and `/mana run` runs entirely on pi workers.

pig is an optional worker route: where pig is installed, lanes may run on pig workers — herdr perceives their state through the pig-side self-report extension; the extension source is in-repo (`extensions/pig/`) and the preflight pig gate is globally installed at `~/.omp/agent/skills/mana/scripts/mana-preflight.sh`.

## Usage

- `/mana <goal>` — **intake**: clarify goal/non-goals/acceptance/risk paths into an acceptable Issue with suggested `tier_grants`; nothing is dispatched.
- `/mana how|why|teach|recall|echo <scope>` — **context**: read-only Q&A; how/why support parallel read-only evidence lanes (how: Complex splits into non-overlapping facets up to `max_parallel_lanes`; why: code anchors first, one investigator per evidence category, four-tier evidence grading); conclusions are delivered in the reply by default and only written to `.mana/<context-id>/` when explicitly requested; `/mana echo` additionally restates the current task goal so drift shows up immediately.
- `/mana architect <scope>` — **context**: read-only multi-lane design entry — 2–3 independent sketch lanes cross-reviewed into one design package under `.mana/<design-id>/`; no implementation code, no push/merge (implementation belongs to `/mana run`).
- `/mana prototype <decision question>` — **context**: read-only prototype entry — throwaway multi-variant prototypes behind one switcher, decided by observation under `.mana/<probe-id>/`; prototypes never reach mainline, no promised auto-screenshots (UI gets to render + human eyeball only).
- `/mana veri <target>` — **context**: read-only verification-skill generation entry — init (five-question interview → generate verify-<app> skill → end-to-end live run) / doctor / status; never touches product code; maintain routine reconciliation (results `clean|changed|blocked`, `--source-only` is partial only).
- `/mana run #<issue>` — **run**: the only start phrase; autonomous landing is the default, `--manual-landing` keeps a human merge gate.

**`/mana veri` in practice** — the core idea: every mana run binds its acceptance to a lane's `head_sha` ("DONE is a claim, not a verdict"), but "how this app is launched, driven, and evidenced" used to live only in each agent's session memory. `/mana veri` turns it into a project-local source of truth: `verify-<app>/SKILL.md` (six sections Launch/Doctor/Drive/Evidence/Cleanup/Helpers, real commands and ready signals, no placeholders) plus a feature map whose ledger (front-matter `last_verified_sha`/`verdict`/`prerequisites`) binds evidence to the SHA — any new commit marks the map stale. Generated skills are live-run end to end before delivery (an unexecuted skill is a draft). Daily use: `init` once per repo; `doctor` at any time (mandatory after major functional changes, read-only); `status` for freshness; `maintain` on a human cadence — outcomes `clean` / `changed` (≤1 PR of proven corrections) / `blocked`, and `--source-only` is `partial`, never treated as clean. Maintain edits only the `verify-<app>/` directory and never product code (doc drift fixes the map, product gaps are reported, not papered over); source-wave lanes are read-only and never carry `--model`; live passes are driven solely by the orchestrator. Canonical install: `~/.pi/agent/skills/verify-<app>/` symlinked into OMP at `~/.omp/agent/skills/verify-<app>`; workers generate in the target repo's worktree and user-level installation stays with the landing phase.

`/mana run` has prerequisites: first run `bash scripts/mana-install.sh` from the mana source repo so `~/.omp/agent/skills/mana/scripts/` contains the run lock and tier guard; the target repo then satisfies the remaining checklist — `.git/info/exclude`, in-repo red-line definitions, an approved `tier_grants`, and the toolchain. Missing any item means context/intake only.

Invariants: never force-push, never touch resources it did not create, never approve a worker's push request, never merge with a failing guard, never report a half-finished lane as complete, never treat a human-waiting UI as control flow, never pin a model in worker args: workers start on pi's current default route; the orchestrator reads the session's first `model_change` into state as evidence and reports any mid-run switch. Orchestrator pushes are limited to this run's own branches (verified-lane snapshots + landing push, append-only); PR bodies are fixed briefs — `## Why` / `## What changed` / `## Scope` / `## Tradeoffs` (omittable) / `## Blast Radius` / `## Verification`, at most ~40 lines, squash commit body = PR body, and every Verification item carries an acceptance command, actual output summary, and bound head SHA.

## License

MIT — see [LICENSE](LICENSE).
