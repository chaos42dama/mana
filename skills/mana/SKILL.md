---
name: mana
description: "OMP orchestrator + Herdr Pi 工人的自主工程流程（/mana）。支持 intake、上下文重建（how/why/teach/recall/echo）与授权后的 Pi lane 自主执行、验收、PR、CI、merge、清理。Triggers: /mana, mana, 自主编排, Pi subagent, 自主 landing, /mana how, /mana why, /mana teach, /mana recall, /mana echo。"
---

# /mana — OMP 自主编排

`/mana` 有四个互斥入口：**context** 只读重建上下文；**intake** 把模糊目标收敛为可验收的 Issue；**run** 只在负责人（下称 CTO）对该 Issue 明确授权后，由当前 OMP session 作为 orchestrator，调度 Herdr 专属 pane 内的 **Pi** 工人完成 dispatch → supervise → verify → land → reclaim；**resume <run-id>** 先只读对账、再按「run 单 owner 执行入口」接管锁恢复既有 run 的监督，不重新 intake 或启动新 run。

> 本技能假定运行环境为 **OMP（oh-my-pi）+ Pi 编码 agent + herdr**，不兼容其它 agent 宿主。

## §0 不变量（违反即停）

1. **state 是唯一事实源**。状态存 `<repo>/.mana/<run-id>/state.json`（`.git/info/exclude` 排除 `.mana/`）。每次监督 sweep 先重读，再原子重写。会话记忆不可信。
2. **DONE 是 claim 不是 verdict**。工人报完成后，orchestrator 必须亲自重跑该 lane 的验收命令，通过才信。
3. **代码 lane 必须 worktree 隔离并由 Pi 执行**。用 `herdr worktree create` 创建本 run 工作区，在其专属 pane 执行 `herdr agent start <name> --kind pi`（pi 线路专用；pig 为可选工人线路，启动见 §2 pig 分支）；不得用 OMP `task`/`workpool` 充当代码工人。只读 lane 同样优先 Pi pane；只有一次性无会话调查才可用 OMP `scout`。
4. **lane 永不 push/merge**。发布权只在 orchestrator，工人永不 push/merge。orchestrator 对远端的 push 仅限两类，且都只针对本 run 创建的分支：§4.1 的 verified 快照推送（每条 code lane 转 `verified` 后推一次 run 分支快照）与 landing push——两类都只追加新 commit，**禁止 force-push**，禁止推 main 或非本 run 的分支。
5. **永不 force-push、永不碰非本 run 创建的分支/worktree/会话**。
6. **一次授权覆盖已批准的 run，tier 由机器判定**（前置：当前仓库已满足「仓库前置条件」节，否则只走 context/intake）。state 写入 `authorization: {issue, approved_at, scope, autonomous_landing: true|false, tier_grants: [{patterns: [路径 glob], max_tier, guard, approved_at}]}`。
   - **`autonomous_landing` 默认 `true`**：CTO 一句 `/mana run #<issue>` 即为逐 run 授权（含“自主 PR→CI→merge→清理”），不再需要长参数。需要保留人工 merge 门时才显式 `/mana run #<issue> --manual-landing`（state 写 `false`）。
   - 默认 true 只免掉「逐次问是否自主落地」这一层，**不改变 tier 判定**：仍须被某条 `tier_grants` 完全覆盖且守卫 `exit 0` 才 landing；未覆盖的 tier B 照旧在 §1.4 预检停。
   - `autonomous_landing=true` 时 tier 不靠人肉判断：变更集被某条 `tier_grants` 完全覆盖、且该条 `guard` 命令 `exit 0` → 该 lane 记 tier A，直接 landing，不再问 CTO。
   - 无 `tier_grants` 覆盖的 tier B 需求在 §1.4 预检就停，不派发；禁止“跑完再问”。
   - pattern 以 `/` 结尾表示授权整棵子树。toml 授权必须同时给 `--allow-key` 键前缀，否则只授权了路径、没授权内容。
   - 共享只读资源（如目标仓的 `res/`）、密钥、认证、支付、非本 run 的资源、main/DBA 强推或删除，始终不在授权范围，任何 `tier_grants` 都不得覆盖。
   - 默认守卫 `scripts/check-mana-grant-scope.py`（本仓库提供，建议复制到目标仓）：`--self-test` 自检；`--paths a,b` 预测模式（只比路径）；`--base origin/main --allow-key ui.txt.` 复核模式（路径 + 键范围）。
   - **常备授权块**：CTO 批准并合入 main 的长周期授权块可直接写进 SKILL.md 或 Issue；run 启动时并入 `state.authorization.tier_grants`，命中即按本条判 tier A，不再逐 Issue 询问。
7. **工人永不因交互 UI 停机**。工人 lane 必须带 `MANA_WORKER=1` 启动（§2 dispatch 的 `--env`）。该模式下三处宿主扩展（本仓库 `extensions/pi/`）同时转入工人语义，各自带内联自检：
   - `mana-worker.ts`：交互式提问类工具（`ask_question`/`question`/`ask`…）在 `tool_call` 阶段直接 block，并把「按 `recommended`/(Recommended) 项自决、把结论写进交付『决策』段」的指令回灌给模型；会话启动 notify 一次，orchestrator 可由 pane 输出确认 env 已生效。自检 `PI_MANA_WORKER_SELFTEST=1 bun extensions/pi/mana-worker.ts`。
   - `safe-guard.ts`：危险 bash 只 `notify` 告警，不弹确认；受保护路径硬 `block`；`.pi/` 命中但落在工作区内（worktree 里的仓库文件，如 `.pi/skills/**`）不算受保护路径，只有工作区外的用户级 `~/.pi/**` 才拦。自检 `PI_SAFE_GUARD_SELFTEST=1 bun extensions/pi/safe-guard.ts`。
   - `precommit-review.ts`：整门关闭，不武装、不拦截、不排队 `/review`。原因：pi-review 的 `/review` 在非空会话里 `ctx.ui.select("Start review in:", ["Empty branch","Current session"])`，收尾还要人工 `/end-review`，工人 pane 没有人类 → 死锁；历史 run 里多个 lane 曾各自临场改用 `PI_SKIP_REVIEW=1` 绕过。审查职责改由 orchestrator 复验与 PR 评审承担。自检 `PI_PRECOMMIT_SELFTEST=1 bun extensions/pi/precommit-review.ts`。
   - `mana-worker-compact.ts`（工人侧 compaction 接管）：`MANA_WORKER=1` 下接管 `session_before_compact`，把工人协议块 + 原始 brief + 上次摘要整段写进压缩结果，压缩后工人不丢交付契约。自检 `PI_MANA_WORKER_COMPACT_SELFTEST=1 bun extensions/pi/mana-worker-compact.ts`；**run 预检必须一并跑**。
   - `mana-compact.ts`（编排者侧 compaction 注入，OMP `extensions/`）：`session.compacting` 时把 §0 不变量 + 当前 run 的 lane 快照 + 下一步注入压缩摘要，压缩后 orchestrator 不丢 state 对账能力；无 `.mana/` 时不干预。自检 `MANA_COMPACT_SELFTEST=1 bun extensions/mana-compact.ts`；**run 预检必须一并跑**。
   - 以上扩展自检与 run 预检（环境/pi 解析/线路/装机/配置）已脚本化为 `scripts/mana-preflight.sh`，run 启动先实跑一遍，全过才派发。
   - 因此 lane 内的 VCS 变更、提交和本地 branch 清理应直接执行；不得把 Herdr `blocked` 当常规控制流。**run 中若仍出现确认 UI，视为配置漂移**：orchestrator 先 `get/read` 查因（首要检查 pane 内 `printenv MANA_WORKER` 是否为 `1`），记录原文并在 state 记 `blocker`；只有当屏幕命令、目标和影响完全匹配 state 中已批准 lane 的本地 worktree 操作时才 `herdr agent send-keys <name> enter`。远端删除、push/merge、共享只读资源、密钥、认证、支付、main/DBA 重写一律 `blocked`。不得盲发 `enter`；宿主强制阻止的确认不是可绕过的授权门，必须记录其原文并上报。
8. **Pi worker 必须回收**。lane 验收后，orchestrator 关闭它创建的专属 pane：`herdr pane close <pane-id>`；随后 `herdr agent get <name>` 和 `herdr pane get <pane-id>` 必须均为 `not_found`。未回收不得报告 run 完成。
9. **orchestrator 自身同样不得停在选择上**。自主 run 内：不调用 `ask`；需要决策时按同一条规则自决（有 `recommended` 取之，否则取自评最优首项），并把结论写进 `state.decision_log`；宿主兜底是 `~/.omp/agent/config.yml` 的 `ask: {timeout: 30}`（超时自动选中 recommended，无则首项；plan mode 下不生效）。只有 tier 判定/授权边界/§0.6 红线才上报 CTO，且一个 run 最多汇总问一次。

### run 单 owner 执行入口

- 任何 run 的 state 写入、Issue 修改、Herdr mutation、push/PR/merge/reclaim 前，orchestrator 必须先启动持锁执行会话。锁覆盖整个 run，不是逐条命令加锁。read-only recall/context 不需要锁。
- `RUN_DIR` 必须是 **canonical 主仓路径** `<主仓>/.mana/<run-id>`，所有会话与 worktree 共用该目录；禁止在各 worktree 下另建同名 run 分裂锁。新 run 只允许先创建这个目录，随后先取锁再初始化 state；旧 run 必须使用既有目录。入口要求目录存在，并以 `Path.resolve(strict=True)` 规范化路径。
- 启动下列持久 shell，让整个 run 的后续命令都发往这一个 shell（主仓与 run 路径替换为实际绝对路径，OWNER 使用可读会话标识）：

  ```sh
  python3 <repo>/scripts/mana-run-lock.py <repo>/.mana/<run-id> <session-id> -- /bin/bash --noprofile --norc
  ```

  （`<repo>` = 当前主仓绝对路径；该脚本是仓库前置，见「仓库前置条件」。）

  后续必须发送到这一个 shell；state 的读取、RMW 和原子替换，以及所有上述 mutation 命令均在此执行。不得另开 `bash`、直接用 `write/edit` 工具或另一个会话绕过。启动失败不得继续发送 mutation；保持该 shell 活到 run 全部操作完成。
- 固定锁文件是 `RUN_DIR/orchestrator.lock`；`fcntl.flock(LOCK_EX|LOCK_NB)` 竞争失败返回 **73**，不会执行子命令。第二会话只能只读或等待显式接管：原 owner 停止 mutation、退出执行会话，确认后代结束，再由新 owner 成功取锁并重读 state。**严禁删除、替换 lock 文件来解决冲突**，否则 inode 分裂会产生双 owner。
- 入口在同一进程 `os.execvpe`，显式设置锁 FD 可继承；shell `exec` 保留锁，无额外 wrapper。正常退出、信号或异常结束时，最后一个持有该 FD 的进程结束才释放锁；exec 失败自动关闭 FD，命令不存在返回 127，其余 exec 错误返回 126。命令退出码原样保留。
- fork 后代会继承锁：后台 child 仍持 FD 时，父进程死亡也不能提前接管。持锁 shell 不得提前关闭 FD；命令若主动关闭未知 FD（例如 `close_fds`）则不能代替原 shell 承担锁生命周期。避免脱离会话的后台 mutation，退出前等待后代完成；不能仅凭 PID 消失或元信息判断可接管。
- `flock` 仅提供合作进程互斥，不是同 UID 安全沙箱，不能阻止直接工具写入。锁文件中的 owner/PID/run_dir 仅用于诊断，不是权限依据，也不是状态库。
- 历史 state/Issue 的修正由 Main 负责：保留原始 `observed_claim`，追加 `correction` 和 `source` 证据；不得把旧 claim 静默改成已验证事实。本入口只实现单 owner 锁，不修历史数据。

### 仓库前置条件（新仓库要用 /mana run 前逐项核对）

全局技能 ≠ 全局可 run。每个仓库独立满足以下前置，缺项只走 context/intake：

1. `scripts/mana-run-lock.py`：run 单 owner 持锁入口（含 `test_mana_run_lock.py`；发布树自带，`cp` 到目标仓 `scripts/` 即装）。
2. `scripts/check-mana-grant-scope.py`：tier 守卫（本仓库自带，`--self-test` 先跑通）。
3. `.git/info/exclude` 含 `.mana/`；`.gitignore` 未跟踪 run 产物。
4. 该仓 AGENTS.md 明确：受保护分支、只读上游区、`tier_grants` 红线的仓内定义。
5. CTO 针对该仓的 `tier_grants` 批准（常备块按仓分节维护）。
6. 工具链就绪：`herdr`、forge CLI 认证、CI 通道、`MANA_AUTONOMOUS=1`、工人侧三处扩展自检绿（§0.7）。

### tier_grants 示例

`tier_grants` 是机器可判定的授权谓词。每个块 = 路径 glob 列表 + 可选 toml 键前缀 + 守卫命令；守卫 `exit 0` 即判 tier A，可自主 landing。

```json
[
  {
    "scope": "前端文案配置化",
    "patterns": [
      "apps/web/",
      "ops/config/copy.*.toml"
    ],
    "max_tier": "A",
    "guard": "python3 scripts/check-mana-grant-scope.py --base origin/main --allow-path apps/web/ --allow-path 'ops/config/copy.*.toml' --allow-key ui.txt.",
    "approved_at": "2026-09-16"
  }
]
```

- 只授权键前缀内的改动（如 `ui.txt.`）：开关/门禁键（如 `ui.access.*`）仍判 tier B，需 CTO 另批。
- 撤销：CTO 明确指示，或删除本块即失效。

### intake（目标尚未成为可执行 Issue）

1. `/mana <目标>` 先像 `ask` 一样追问**目标、非目标、验收、风险路径、需决策项**；不派发、不写业务代码。
2. 把结论写成/更新 Issue（forge CLI：`gh`/`fj`/`glab` 任一，本文以 `gh` 示例）：每个 lane 有目标、文件边界、可执行 acceptance、tier、合并后清理；并**给出建议的 `tier_grants` 块**（pattern 列表 + `--allow-key` + guard 命令），供 CTO 一次批准。列出唯一启动口令：`/mana run #<issue>`（默认即自主 landing；仅当要保留人工 merge 门才加 `--manual-landing`）。
   Issue 定稿后、进入 run 之前，先跑骨架校验：`python3 scripts/check-mana-issue.py --body <file>`（或 `--number <N>` 经 forge CLI 取正文）——`exit 0` 才可授权；非 0 则回 intake 补齐缺项，不得带着缺项进 run。
3. CTO 确认 Issue 和启动口令后，才进入 run。OMP goal runtime 只是便利层（暴露 goal tool 时才 arm），**不是权威续航，也不取代 intake 的需求澄清**：intake 阶段不得把 goal runtime 当作需求澄清或续航的依赖——`state.json` + `scripts/mana-heartbeat.sh` 心跳才是唯一权威续航（与 §1 run 第 2 步同口径）。

#### 设计审查四红旗（intake 阶段筛设计）

筛选视角：**假定下一个贡献者是 agent**——它只看得见自己打开的文件、照抄最近的例子、走能编译的最短路径。所以一个改动若只从单个文件看是对的、对全仓却不对，就是设计缺陷。在 intake 阶段挡掉这种缺陷，比在 review 阶段靠人逐个发现便宜。

| 红旗 | 定义 | 何时用 |
| --- | --- | --- |
| **split ownership** | 一份状态有两个写者（同一份文件/表/配置被两处代码各自修改） | 两个模块都要写同一份数据时：先定单一写者，另一处只读或走接口；定不下来就拆状态，别共享 |
| **two ways to do one task** | 同一件事有两条路（两个函数/脚本/命令做同一件事） | 发现第二份实现或第二套用法时：删旧留新或合并成一个；加路径前先问「旧的能不能改」 |
| **importable internals** | 内部实现可被外部 import/引用（没有 seam 的模块，内部符号暴露成公共入口） | 新模块被边界外 import，或内部函数被当公共 API 用时：收窄导出面，只留一个入口 |
| **hand-synced list** | 手工同步的清单（同一份内容多处各维护一份，靠人记得同步） | 看到「复制到另一处」「两处要保持一致」「记得同步」时：改成单一事实源 + 脚本/生成器同步，别靠人记 |

本仓只提供**视角**，不在这里实现自动化的多线路设计审查：`/mana architect`（多线路 sketch + 交叉评审）由 **Issue #13** 承接，本文件不承诺未实现的能力。
本仓已有该视角的实证：装机同步曾是典型 hand-synced list（`~/.omp/agent/skills/mana/SKILL.md` 曾落后正本 165 行）——`scripts/mana-install.sh` 即消除它、把用户级目录变成仓库正本安装产物的手段；`scripts/mana-preflight.sh` 装机门同样用 `cmp -s` 对正本而不是再维护一份文件清单。

### context（不启动 lane、不写业务代码）

`/mana how <范围>`、`/mana why <范围>`、`/mana teach <范围>`、`/mana recall <主题>`、`/mana echo <关键问题 或 #N>` 是高频上下文问答的最小等价入口，不另造多套项目技能。

1. **how**：以代码、运行命令、LSP 或 codebase-memory 为证据，说明当前架构、运行数据流、文件归属与边界；不把推测写成事实。
2. **why**：先锚定代码和提交，再并行查 git/jj log/blame、Issue/PR 评论、项目文档与可用运行证据；输出事实、合理推断、未知项及来源。
3. **teach**：复用 how 和 why 的证据，以中文分层解释“它是什么、怎样运作、为什么这样取舍”；涉及三项以上参与者时用递进图，不改代码。
4. **recall**：默认回看本仓最近七天的会话记忆、`.mana/*/state.json`、Issue/PR、分支和 worktree 现状，产出至多五条的当前状态、未决问题和唯一下一步；用户给出完整状态时不重复挖掘。
5. **echo**：目标对齐自检——检验的是**对当前任务目标的理解**是否偏移，不是项目状态（那是 recall）。只读：不写代码、不派 lane、不改 Issue、不碰 state。步骤：① 用自己的话重述「我认为你的目标是什么、我试图解决的问题是什么」；② 给 `#N` 时先读该 Issue 全文与已有评论，输出「Issue 原文目标 vs 我当前理解」的 diff 并标出偏移；③ 不清楚处**立即反问并停在这里，不落笔**；④ 末尾列出需要 CTO 拍板的分歧点清单。发现偏移只报告、不自行纠正，要改转 intake。回复优先评论到对应 Issue，只给结论 + 关键证据 + 方案。
6. context 是只读入口。需要改动时转 intake；已有已授权 Issue 时转 run。不得在 context 静默派发 worker、修改 Issue 或扩大授权。

### run（已批准 Issue）

1. 先按「run 单 owner 执行入口」启动持锁 shell，再执行以下写入与 mutation。读 Issue 全文与已有评论（forge CLI），确认已批准的子任务分解与授权范围：`autonomous_landing` 缺省为 `true`，仅 `--manual-landing` 时为 `false`，并写入 state；缺任一项 → 只回 intake，不 dispatch。
2. 把可检查的终态写入 state 的 `goal` 字段；当前 OMP runtime 暴露 `/goal` 或 goal tool 时同步 arm。**goal runtime 只是便利层**：`state.json` + `scripts/mana-heartbeat.sh` 心跳才是唯一权威续航机制，goal runtime 丢失、被压缩失效、或当前 runtime 未暴露 goal 工具，都**不构成 run 中断**，也不得作为停止理由。终态未满足不得因 worker 结束而停机。
3. 写 lanes 表进 state.json：`{run_id, base_ref, authorization{...,tier_grants}, goal, max_parallel_lanes, lanes: [{id, kind: readonly|code, target, acceptance: [命令或可观察断言], head_sha, verdict, tier, tier_grant, guard_output, branch, workspace_id, pane_id, agent_name, attempt: <整数，从 1 起；1＝首轮，2＝唯一一次重派>, superseded_by_agent: <被当前 agent 取代的旧 agent 名，首轮为 null，用于重派对账>, model: <provider>/<id>（启动后回读取证）, max_wall_minutes, max_rounds, retry_mode, status: planned|running|verifying|verified|reclaimed|landed|blocked|failed}]}`。`tier_grant` 记命中的 grant 索引，`guard_output` 记守卫命令的实际输出摘要。
   - **验证账本**：`head_sha` 记验收通过当时该 lane worktree 的 `git rev-parse HEAD`；`verdict` ∈ {`live`, `unit`, `type-only`, `blocked`, `failed`}，每个值由哪类 acceptance 支撑：`live`＝真实服务/端到端断言实跑通过，`unit`＝单元或静态断言实跑通过，`type-only`＝只做了类型检查或文本断言（未实跑业务路径），`blocked`＝lane 被 blocker 挡住未完成验收，`failed`＝acceptance 实跑失败。结论只在其 `head_sha` 上有效。
   - **失效规则**：任何产生新 commit 的动作（重派、打回修复、改代码后重验）之后，旧 `head_sha` 上的 `verified`/`landed` 结论一律作废，必须在新 `head_sha` 上重跑 acceptance 才可恢复；恢复时以新 `head_sha` + 新 `verdict` 覆盖账本。
   - **重派账目**：`attempt` 从 1 起，`1`＝首轮，`2`＝唯一一次重派（§3 第 2 条）；第 2 轮生效时旧 agent 名移入 `superseded_by_agent`，`agent_name`/`pane_id` 更新为新值——旧 agent 名由此保留，可与 pane/agent 回收 `not_found` 证据、合并 brief、`decisions.tsv` 三处互证对账。
   - **决策轨迹落盘**：编排者把 `state.decision_log` 的每条决策在持锁 shell 内同步写到 `.mana/<run-id>/decisions.tsv`（同源同内容；`.mana/` 不进版本库，工人不写它）。表头固定 6 列：`time<TAB>phase<TAB>decision<TAB>reason<TAB>evidence<TAB>result`（`<TAB>` 为制表符，每行恰好 6 列）。留档口径：`evidence` 可截断到判定所需的最小片段，但脏树处置（§3 第 2 步 ① 取证）的 `evidence` 必须含 `git diff --stat` 汇总行与至少一处代表性 hunk（`git diff` 原文），截断须注明范围（如「…中间省略 N 行…」），不得以截断掩盖语义改动。
   - **重试与预算字段**：`max_wall_minutes`（默认 30，lane 首次 dispatch 时写入）＝该 lane 的墙钟预算；`max_rounds`（默认 2）＝§2/§3「同一 lane 最多 2 轮」的那个数——两处只是同一字段的两个视角，不是两个数；`retry_mode` ∈ {`network`,`context-overflow`,`tool-error`,`none`}＝该 lane 当前失败的归类，每次重投前更新。
   - **重试分类表**（每次重投前先归类，动作落 `decision_log`/`decisions.tsv`）：

     | `retry_mode` | 识别信号 | 动作 | 消耗 `max_rounds` | 消耗墙钟 | 记什么 |
     | --- | --- | --- | --- | --- | --- |
     | `network` | 传输/超时类瞬时错误（prompt 未投递、连接中断） | 原样重投同一 lane 同一 brief | 否 | 是 | `decision_log` 一行 |
     | `context-overflow` | 上下文溢出 / compact 丢失协议 | 先按 §0.7 跑 compaction 扩展自检取证，再缩小文件边界后重投 | 是 | 是 | `decision_log`（含取证与新边界） |
     | `tool-error` | 工具/宿主侧确定性错误 | 记 `state.blocker` + 原文；**不自动换线**（CTO 决策：工人只用 pi 默认线路，编排者仅按 §2 回读取证），也不自行换 brief 反复试 | 否 | 否（记账后即上报） | `state.blocker` + `decision_log` |
     | `none` | 无可重试的失败 / 不许重试 | 不重试，直接置终态 `blocked`/`failed` | — | — | 终态 + `decision_log` |

   - **墙钟超时不等于失败**：超过 `max_wall_minutes` 时不得直接判 `blocked`/`failed`，必须先 `herdr agent get`/`read` 取证，再按 §0.7 裁决（prompt 未投递 / 配置漂移 / 真 `BLOCKED:`）；裁决结果写 `decision_log`，取证仍无定论才置 `blocked`。
   - **并发上限**：state 顶层 `max_parallel_lanes`（默认 2）只约束**同时处于 `running` 的 code lane 数**，readonly lane 不计入；达到上限时新 lane 保持 `planned`，直到有 code lane 离开 `running` 再派发。

4. 预检（已脚本化为 `scripts/mana-preflight.sh`，任一项失败非 0 即停，run 启动先跑它；下述清单即脚本覆盖的语义）：`HERDR_ENV=1`、`herdr status`、Pi 入口、push/forge 认证/CI 通道，确认本 pane 已启用自主模式（`printenv MANA_AUTONOMOUS` 为 `1`，否则 safe-guard 会在 run 中途弹确认），确认工人侧三处扩展（§0.7）已装入 `~/.pi/agent/extensions/` 且三条 `*_SELFTEST=1 bun …` 全绿、`~/.omp/agent/config.yml` 含 `ask: {timeout: 30}`，读出 pi 当前的默认线路写入 `state.worker_model`（**仅记录与对照，不改写、不传派发参数**）：`jq -r '.defaultProvider + "/" + .defaultModel' ~/.pi/agent/settings.json`（缺任一字段即预检失败，不得猜），并**先算 tier**：对每条 lane 的 `target` 路径跑 `check-mana-grant-scope.py --paths <paths> --allow-path ...`。未被 `tier_grants` 覆盖的 tier B lane 在这里一次性汇总上报 CTO（一个 run 最多问一次），获批后写入 `tier_grants` 再派发。缺任一预检项现在报，别等 N 条 lane 跑完。pig 为可选工人线路：预检 f 段（pig 门）仅在 pig 二进制在位时校验 pig 侧 herdr 状态扩展（`~/.pig/agent/extensions/herdr-agent-state.ts`）的装机与 `reportArgs` 自检，未装 pig 则 SKIP 不拦。
5. 若新增 lane、扩大文件/路径边界或改变 acceptance，回 intake 更新 Issue 后重新获得一次 CTO 授权；不偷渡范围。

### resume（崩溃/重启恢复）

`/mana resume <run-id>` 是第四个互斥入口：对账阶段只读恢复既有 run 的监督上下文；它不替代 intake 或 run。对账完成后，新会话按「run 单 owner 执行入口」的既有接管流程，在原 owner 已停止且锁已释放时取锁并重读 state，成为新的 run owner；随后在持锁 shell 内按 run 流程执行必要 mutation、重派和后续监督。

1. 重读 `<repo>/.mana/<run-id>/state.json` 和对应 Issue 全文及已有评论。找不到 state 时只报告缺失，不猜测、不重建。
2. 逐 lane 对账：运行 `herdr agent get <name>` / `herdr pane get <pane-id>` 检查存活情况，并在登记的 worktree 中运行 `git -C <worktree> rev-parse HEAD`，与 state 中记录的分支和 SHA 对照；记录最后证据。
3. `verified|reclaimed|landed` lane 不重做；仍存活的 lane 重新挂回监督。对已死亡 lane，新 run owner 在持锁 shell 内记录合成 postmortem（lane、失败模式、最后证据）到 `decision_log`，再按合并 brief（§2 模板）重派：拼 brief 前必须先读旧 agent 的最终状态行原文（`DONE:`/`BLOCKED:` 逐字）与该 lane worktree 的 head SHA（`git rev-parse HEAD`；未提交则逐字附 `git status --short` 原文），连同原始 brief 全文与全部后续指令一次投齐；同一 lane 的重派计入其 `max_rounds` 上限（默认 2，见 §1 run 第 3 步），并按 `attempt` 语义推进——第 2 轮按 §3 第 2 条顺序换 fresh agent。
4. 新 run owner 按 state 继续监督、验收并报告完整终态，不把存活/完成状态建立在会话记忆或推测上。

Issue #8 验收原文：

> 在 run 中途 kill 编排者后执行 /mana resume <run-id>：不重复派发已完成的 lane，死掉的 lane 被重派，最终报告完整。

## §2 dispatch

**线路只有一条规则：人工预配置好的 pi 默认线路**。**不存在按 lane 指定或升级线路的口子**（含 verifier lane 在内，每次工人 pi 一律使用默认线路）；orchestrator 不传 `--model`、不改写 `state.worker_model`，只做事后回读取证：工人 pi 启动时按 `~/.pi/agent/settings.json` 的当前默认线路直接使用，orchestrator 启动后回读实际线路写进 state 取证（见下条）。

- 每条需持续会话的 lane（pi 线路；pig 分支见下条）：先从当前 orchestrator pane 用 `herdr pane split --current --direction down --cwd <worktree-path> --env MANA_WORKER=1 --no-focus` 创建**下方横切**的本 run 专属 pane（`--env` 落在 pane 的 shell 上，pi 继承；不得用 `--direction right`）。读取返回的 `workspace_id`、`pane_id` 后直接启动：`herdr agent start <agent-name> --kind pi --pane <pane-id> -- --exclude-tools ask_question`（`--` 之后是 pi 原生参数；**不带 `--model`**——线路由 pi 启动时按配置默认顺势使用）。`<agent-name>` 和 branch 必须唯一，写入 state。
- **pig lane 分支（可选工人线路；除本条所列差异外，其余规则与 pi 线路共用）**：herdr 不识别 pig（`--kind` 无 `pig` 取值、无屏检测），**不用 named agent API，全程走 pane API**——pane split 同上条（`--env MANA_WORKER=1` 照带），随后 `herdr pane run <pane-id> pig -a`（`-a` 跳过项目信任提示；herdr 对 pig 的状态感知靠 pig 侧自报扩展 `~/.pig/agent/extensions/herdr-agent-state.ts`，扩展从 `~/.pig/agent/extensions` 自动发现、无需 `-e`，装机由本仓 `extensions/pig/` 与 `scripts/mana-preflight.sh` f 段 pig 门保证；**不传 `--model`**，与 pi 同策略，线路靠事后回读取证）。pig lane 的 `agent_name` 记 pane id：`herdr agent get/read/wait` 均以 pane id 为 target。打回/重投不用 `herdr agent prompt`/`herdr agent send-keys`（对 pig 报 `agent_not_ready: not an active named agent`），改用 `herdr pane send-text <pane> <text>` 紧接 `herdr pane send-keys <pane> enter` 投递。
- **实际线路靠回读取证，不靠锁（pi/pig 两条线路共用本条结论，仅取证路径分线路）**：每条 lane 启动后读会话 jsonl 的**首条** `type == "model_change"` 记录的 `provider`/`modelId` 写入 `state.lanes[].model`，以事实值为准：与 `state.worker_model` 不一致时在 state 记一行原因（run 期间 pi 默认可能已被切换），不因此停 lane。运行中 jsonl **新增** `model_change` 属中途换线：记 `blocker` 与原文上报，不自行换回。取证路径：pi 用 `herdr agent get <agent-name>` 取 `agent_session` 指向的会话 jsonl（`pi --list-models` 非交互模式不可用，勿用）；pig 的 `agent_session` 在 herdr 0.9.0 下恒为 null（即使自报扩展带了 `--agent-session-path`），改扫 `~/.pig/agent/sessions/<slug>/*.jsonl` 里**最新的那份**，同样读首条 `model_change`。
- 工人侧三处扩展（§0.7）由 `MANA_WORKER=1` 自动接管，brief **不再需要**逐条交代 `PI_SKIP_REVIEW=1` 之类的绕过技巧；brief 只写业务边界。
- Pi brief 用三段式（借 pi-crew 的 `goal/context/instructions`）：`goal` 一句话写完成态与判定方式；`context` 只放仓库里查不到的事实（CTO 已批准的范围与决策、lane 边界）；`instructions` 每条一个动作或一条禁令，末尾给停止条件。另需包含：逐条 acceptance 命令、文件/路径边界、禁触共享只读资源、禁 push/PR/merge/关闭自身 pane、禁运行 `/review` 与 `/end-review`、禁提问（要决策就自决并写入『决策』段）、交付洁净契约（`DONE:` 前工作区必须洁净，见下条）、交付格式。改动落在 `tier_grants` 内时，acceptance 必须包含一条 `python3 scripts/check-mana-grant-scope.py --base origin/main --allow-key <前缀>`，让工人在自己的 worktree 内先自证键范围。不得要求 worker 自开 PR、merge 或关闭自身 pane，也不得把决策委派给工人。
- 工人交付：完成所有工作后只输出一个机器可解析的最终状态行，且**首字符必须为** `DONE:` 或 `BLOCKED:`；随后可列证据（命令输出/路径/diff 摘要）。未出现该前缀的自然语言“完成”不是终态，orchestrator 必须 `read` 后追问，不得回收。**交付洁净契约**：输出 `DONE:` 前该 lane worktree 的工作区必须洁净——`git status --short` 输出为空；若存在纯格式化或工具自动改写（如 pi-lens deferred format 留下的改动），必须与成果一并 commit，不得静默丢弃；不得以「保持工作区干净」为名丢弃任何语义改动。
- 工人 `BLOCKED:` 后必须紧跟两行：`QUESTION:` 与 `RECOMMENDED:`（工人自评的建议项）。这是 needs_input 而不是失败：orchestrator 先在授权范围内按 `RECOMMENDED` 自决，写入 `state.decision_log`，再按 attempt 规则重投——`attempt=1` 可 `herdr agent prompt` 复用同 pane 投递自决结论；`attempt=2` 必须换 fresh agent（按 §3 第 2 条顺序：回收旧 pane → 双 `not_found` → 新 pane + 新 agent，仍不传 `--model`），并把自决结论写进合并 brief（见下）的「历次后续指令」与「已作出的自决结论」字段。重投最多 2 轮——即该 lane 的 `max_rounds` 字段（默认 2，见 §1 run 第 3 步），与 `attempt ≤ 2` 是同一上限的两个视角；超限置 `blocked`；只有决策触及 tier 判定/授权边界/§0.6 红线才上报 CTO。**不要在 run 中途把工人的问题原样转给 CTO**。
- `agent_prompt_stalled` 或 wait timeout 不代表未投递或失败；先 `herdr agent get/read`，不得重复 prompt。实际确认 UI 按 §0.7 裁决。

### 合并 brief 模板

采纳 pstack（cursor/plugins `pstack` 0.15.6，commit `23e4138d`）的 “Fresh subagents by default” 语义：默认每次重派都是 fresh worker，不靠 interrupt-chained resume 续会话——那会静默丢指令。brief 必须**合并**：原始 brief 全文 + 之后所有指令 + 前一 agent 的最终状态与现场，一次投齐；禁止摘要、禁止「同前」「见上」。

```text
【合并 brief】<lane-id> 第 <attempt> 轮

## goal
<原始 brief 的 goal 全文，逐字>

## context
<原始 brief 的 context 全文，逐字>

## instructions
<原始 brief 的 instructions 全文，逐字>

## 历次后续指令（按时间顺序，逐条原文）
- [<轮次+来源>] <指令原文>   # 来源 ∈ {编排者打回, BLOCKED 自决重投, resume 指令}

## 前一轮最终状态行（逐字）
<`DONE:` 或 `BLOCKED:` 开头的那一行原文>

## 前一轮现场
- 分支：<branch 名>
- head SHA：<git rev-parse HEAD 输出；若已提交>
- 未提交则写明工作树脏，并逐字附 `git status --short` 原文

## 前一轮验收失败实际输出（编排者复跑原文）
<命令 + 原样输出，非「验收失败」之类描述>

## 已作出的自决结论（来自 state.decision_log）
<每条：决策 + 理由 + 证据；无则写「无」>

## 本轮 acceptance 命令清单
<逐条命令>

## 停止条件
<逐条；与原始 brief 一致或显式收窄>
```

`goal`/`context`/`instructions` 三段必须全文搬入（不是摘要）；凡是发生重派（打回修复、BLOCKED 自决重投、resume 重派）都改用本模板投递。

### 审批模式与真实授权门

- **真实的人为门是 `~/.omp/agent/extensions/safe-guard.ts`**（本仓库 `extensions/safe-guard.ts`），不是 OMP 内置审批：该扩展在 `tool_call` 钩子里匹配 `DANGEROUS_PATTERNS` 后调用 `ctx.ui.confirm("⚠️ Dangerous Command", ...)`，**完全不读 `tools.approvalMode`**，所以 yolo 拦不住它。
- 该扩展已加**启动时一次性授权**开关：`MANA_AUTONOMOUS=1`（或 `OMP_SAFE_GUARD=off`）时跳过 bash 危险命令确认，改为 `ui.notify` warning 审计；受保护路径（`.env`、`.git/`、`.ssh/`、`node_modules/`、`.omp/`）的确认与无 UI 时的硬阻断**不变**——密钥/认证红线不因自主模式放开。自检：`bun checks/safe-guard.check.mjs`（5 组断言：默认必确认、自主模式放行且通知、受保护路径仍拦、无 UI 硬阻断、pattern 回归）。
- 因此自主 run 的启动形态是 `MANA_AUTONOMOUS=1 omp`；建议把 `export MANA_AUTONOMOUS=1` 写进 `~/.bashrc` 作为默认，交互式 pane 天然满足，单次恢复人工确认用 `MANA_AUTONOMOUS=0 omp`。OMP 侧 `tools.approvalMode` 默认已是 `yolo`，`omp --approval-mode yolo` 只是显式化：**别把 yolo 当作 safe-guard 的开关**。策略优先用 `deny`/`bash.patterns` 拒绝危险命令，不要用 `prompt`——headless run 里 `prompt` 等于静默停摆。
- Pi 工人**没有**审批层：`@earendil-works/pi-coding-agent` bundle 内不存在 `approvalMode`/`autoApprove`，`hasUI`/`ui.confirm` 是扩展概念。但工人的交互门来自扩展，共三处，全部由 `MANA_WORKER=1` 关闭/降级（§0.7）：提问工具被封、危险 bash 只告警、`precommit-review` 整门关闭。带 `MANA_WORKER=1` 的 lane 停住只可能是 prompt 未投递、上下文或模型自报 `BLOCKED:`。
- `herdr agent prompt` 参数形态：`herdr agent prompt <TARGET> <TEXT> --wait --timeout <MS>`——位置参数必须在前、选项在后（写反报 `unknown option: <text>`）；`--timeout` 单位是**毫秒**且必须与 `--wait` 同用（否则报 `--timeout requires --wait`）。
- 结论：人为门只剩两处——(a) 宿主扩展的确认（OMP 侧用 `MANA_AUTONOMOUS=1`、Pi 工人侧用 `MANA_WORKER=1` 一次性关掉）、(b) `tier_grants` 覆盖不到的变更（§0.6）。不要把审批 UI 当授权门，也不要靠临场 `send-keys` 把 UI 顶过去。

## §3 监督循环

每轮 sweep 的**第一步是固定顺序的「三读」，三读完成前不处理 lane 事件**——会话记忆不可信，压缩/恢复后尤其如此：

1. **读 state**：重读 `.mana/<run-id>/state.json`（唯一事实源）。
2. **读技能正本并比对 hash**：从 origin/main 重读本技能文件（`skills/mana/SKILL.md`）与在用版比对（可直接复制；技能装在其它路径时替换为实际路径）：

   ```sh
   git fetch origin main
   main_hash=$(git show origin/main:skills/mana/SKILL.md | git hash-object --stdin)  # 主干版 hash
   used_hash=$(git hash-object skills/mana/SKILL.md)                                 # 在用版 hash
   ```

3. **读 lane 事件**：优先用 `herdr agent wait <worker>`（可带 `--timeout`）事件驱动阻塞等待来收 lane 事件，不空转；（编排者 pane 意外空闲时）由 `scripts/mana-heartbeat.sh`（可 crontab 定时的心跳兜底）负责唤醒 sweep；引用 Issue #9。

**pig lane 等待语义（pane API，无 named agent）**：pig 完成一轮后 herdr 显示 **done** 而非 idle。**等本轮开始**：`pane send-text` + `pane send-keys enter` 之后**立即** `herdr agent wait <pane> --until working --timeout <MS>`——先 sleep 会错过短 working 窗口；**等本轮结束**：`herdr agent wait <pane> --until done --timeout <MS>`。`--until idle` 只在从未 working 过的初始空闲上可靠，**不得**当完成信号（工作过的空闲上必超时）。

**drift 记账**：每轮 sweep 完成后把 `drift_checked_at`（UTC ISO，如 `2026-01-01T00:00:00Z`）与是否命中漂移写回 state（`drift: true|false`）。`used_hash != main_hash` 即**技能漂移**：state 记 `drift: true` 并写明两版 hash（`drift_versions: {used, main}`），**按主干版继续执行**（以其 §0/§3 语义为准），**不得静默沿用旧版**；两 hash 一致则记 `drift: false`（no_drift）。漂移命中后的后续动作只有一条：**按主干版继续，并在 §5 报告里列出**。随后按序执行：

1. 重读 state.json；对每条运行 lane 执行 `herdr agent get <name>`，必要时 `read`；运行时长已超过其 `max_wall_minutes` 的 lane 按 §1 run 第 3 步「墙钟超时不等于失败」先取证再裁决，不直接置失败。
2. `DONE` 是 claim，且绑 SHA 前先查工作树：orchestrator 先在该 lane worktree 跑 `git status --short`——非空则**不绑 `head_sha`、不判 `verified`**，也不得先处置，必须按下面的可审计三步走（先取证再归类后处置；**取证缺失 ⇒ 不得处置**：不得 commit、不得 discard、不得绑 SHA）；处置完再重跑 acceptance 命令。
   - **① 取证**：在决定 commit 或 discard 之前，把 `git status --short` 与 `git diff`（含 `git diff --stat` 汇总行）的**原文**逐字写入 `decision_log.evidence`（同步 `decisions.tsv`）；留档口径（可截断到判定所需最小片段，但必含 `--stat` 汇总行 + 至少一处代表性 hunk，截断须注明范围）见 §1 run 第 3 步「决策轨迹落盘」。
   - **② 归类**：按 diff 原文判定 (a) 纯格式化/工具自动改写（仅空白、换行、引号、缩进、行宽重排，无语义变化）还是 (b) 含语义改动（增删改断言、逻辑、契约文本）；归类依据（支持结论的 diff 片段）一并写进 `decision_log`。
   - **③ 处置**：(a) 默认与成果一并 commit——优先同一 attempt 内让工人自己 commit；工人已收尾/不可用时编排者可代为 commit，须在 `decision_log` 标注「编排者代 commit」。(b) **禁止静默丢弃**：必须打回让工人 commit 或明确说明；该打回是洁净门整改、不是 §2 重试，`attempt` 不推进、`max_rounds` 不消耗；若最终决定丢弃，同样不消耗轮次，但 §5 报告 `Attention` 段必须列出被丢弃的语义改动摘要。
   处置完重跑 acceptance 命令：通过后把实际输出写入 state，状态更新为 `verified`；失败打回按 `attempt` 走（打回最多 2 轮——其 `max_rounds` 字段，默认 2，超限置 `blocked`）：
   - **`attempt=1`（首轮打回）**：`herdr agent prompt <agent> <打回指令> --wait --timeout <MS>` 复用同 pane。
   - **`attempt=2`（唯一一次重派）**：换 fresh worker，顺序固定——① `herdr pane close <旧 pane-id>`；② `herdr agent get <旧 agent-name>` 与 `herdr pane get <旧 pane-id>` 双 `not_found` 验证；③ 新建 pane，必须带 `--env MANA_WORKER=1`（同 §2 dispatch）；④ `herdr agent start <新 agent 名> --kind pi --pane <新 pane-id> -- --exclude-tools ask_question`（**仍不得传 `--model`**；pig 线路此步对新 pane 改 `herdr pane run <pane> pig -a`，brief 投递同样走 `pane send-text`+`send-keys enter`，见 §2 pig 分支）；⑤ 用合并 brief（§2 模板）投递。state 同步：`superseded_by_agent` 记旧 agent 名（旧名保留可对账），`agent_name`/`pane_id` 更新为新值，`attempt` 置 `2`。
   打回修复等产生新 commit 的动作触发 §1 run 第 3 步失效规则：旧 `head_sha` 上的结论作废，重验必须在新 `head_sha` 上重跑 acceptance，并更新 `head_sha`/`verdict`。
3. 工人报 `BLOCKED:` → 按 §2 的 needs_input 规则自决并重投（≤ 该 lane 的 `max_rounds`；attempt 语义与第 2 条一致：第 1 轮可同 pane，第 2 轮必须 fresh agent + 合并 brief）。若出现确认 UI（配置漂移）按 §0.7 查因裁决；仍不能自动放行的操作写入 state 的 `blocker` 并上报。pig lane 的 needs_input 判定不依赖 herdr 状态机——pig 扩展无法拦截 `ctx.ui.confirm/select`、`blocked` 不可自报，只认工人自报的终态三行协议：`BLOCKED:` 开头、紧跟 `QUESTION:` 与 `RECOMMENDED:`。
4. `verified` lane 立即 `herdr pane close <pane-id>`，再以 `agent get`、`pane get` 双 `not_found` 验证，状态置 `reclaimed`。不得关闭非本 run 创建的 pane。
5. 所有 lane 都为 `reclaimed|blocked|failed` 才进入 landing；不得因关闭 worker 而遗失 state 或验收证据。

## §4 landing（仅 orchestrator）

1. 仅对 `reclaimed` 且 acceptance 已记录通过的 code lane：orchestrator 在 state 登记的隔离分支提交、push；有冲突则在本 run worktree 解决并重验。
   - **verified 快照推送**：每条 lane 状态转为 `verified` 后，由 **orchestrator**（不是工人；§0.4「lane 永不 push/merge」不变，本条只放开 orchestrator 侧）把该 run 分支推送到远端一次，形成远端耐久轨迹，供 `/mana resume` 对账使用——快照仅限 code lane（readonly lane 无 run 分支）。快照推送只追加新 commit——**禁止 force-push**（远端已有历史时只能追加）；禁止推 main；禁止推非本 run 创建的分支。push 失败记入 `state.blocker` 并在 §5 Attention 报告，**不阻断验收**——验收与推送是两件事。
2. 使用 forge CLI（以 `gh` 为例）建 PR：`gh pr create --head <branch> --base main "#<issue>: <summary>"`，PR body 按下方固定模板写。**PR body 是简报不是实验记录**：评审者已有 diff，body 只回答「为什么存在 / 改了什么 / 刻意不做什么 / 可能影响谁 / 怎么证明的」，一分钟内读完。squash merge 的 commit body 就是 PR body；**全文超过约 40 行就砍**；不贴完整 SHA、不罗列 lane、不写逐文件清单、不写 `CLEAN` 之类结论——细节放链接产物。分段用 `##` 标题（不用粗体引导），顺序固定：

   ```markdown
   ## Why
   <1–3 句：问题 + 做法>

   ## What changed
   <1–3 条；只在承载改动时才点名符号或路径；重命名/改指向写清两侧>

   ## Scope
   <1–3 条；必须明说覆盖什么、故意留下什么；不写逐文件清单>

   ## Tradeoffs
   <只写评审会问的取舍；没有真实取舍就整节省略>

   ## Blast Radius
   <1–2 句：谁/什么受影响、为何安全或危险；主干红灯时写出放着不管的代价>

   ## Verification
   <1–3 条；每条三件套：验收命令 + 实际输出摘要 + 绑定的 head SHA；没有实际输出的条目不许写>
   ```

3. 等 CI（如 GitHub Actions：`gh run list` / `gh run watch <run-id>`）与项目验收命令；失败则修复、重验，不能因“已授权”跳过。
4. merge 前对 PR 的真实 diff 复跑授权守卫，把命令与输出写进 state：`authorization.autonomous_landing=true` 且守卫 `exit 0` → 执行 squash merge（`gh pr merge --squash --delete-branch` / `fj pr merge -M squash -d`）；守卫非 0（越出 `tier_grants`）→ 不合并，按 §0.6 上报 CTO。`--manual-landing`（`autonomous_landing=false`）时，PR/CI 后上报 CTO。
5. PR merge 确认后，orchestrator 移除本 run worktree，删除本地/远端 feature branch，`git fetch --prune` 验证无残留；最后评论并关闭 Issue。

## §5 报告

全程证据与结论优先评论到对应 Issue（forge CLI）；最终报告含：授权范围、lane 表终态、每条验收实际输出、Pi pane 回收双 `not_found`、PR 号、CI、merge、worktree/branch 清理与后续建议。

最终报告另设 `Attention` 段：从 `.mana/<run-id>/decisions.tsv` 引出需要人工注意的决策条目（如触碰授权边界、被否决的方案、留有疑义的自决）；无条目时写「无」。固定要求：本 run 内凡发生「编排者代 commit」（§3 第 2 步三步处置 (a)、工人已收尾）或「丢弃含语义改动的 diff」（(b) 仍要丢弃），各列一条，可从 `decisions.tsv` 的 `evidence` 列引用。

### run 后复盘（mistake class 强制化）

run 终态（全部 lane `landed|blocked|failed`）后做一次复盘，四个动作按序执行：

1. **挖类目**：读本 run 的 `state.decision_log`、`blockers`、`decisions.tsv` 与 Issue 评论；同一失误出现**两次及以上**（跨 run 或同 run）才算一个 mistake class（失误类目），只出现一次不算——避免把偶发当规则。可用 `bash scripts/mana-postmortem.sh <run-dir>` 从 state.json 抽 blockers/decision_log 逐条摘要、按 phase 计数并标出疑似重复关键词辅助判类，判定仍以人工为准。
2. **选层级**：每个 mistake class 按**最高可行**层级强制：`1 架构消除 → 2 类型/lint/CI → 3 测试行为 → 4 文档/agent 规则（最后）`；选中哪层就写明为什么更高一层不成立（无权限、属跨 run 基础设施等）。
3. **取证**：任何新增的强制手段（脚本/检查/测试）必须先在**一条真实历史错误**上失败一次，留下失败输出作为证据，本地与 CI 用同一命令；仅有文档改动视为不满足本条，必须标注「待有下一次真实错误时验证」。
4. **红线只上报**：复盘不得在本 run 内顺手改 `tier_grants`、`scripts/mana-run-lock.py`、`scripts/check-mana-grant-scope.py` 或其他 run 基础设施；触及这些一律写进 §5 `Attention` 上报 CTO。

复盘产出的新规则与强制手段回填 `AGENTS.md` 的「规则 ↔ 强制手段 ↔ 首次发现 run」对照表；规则已存在但无强制手段 = 重复发生，同一变更补齐强制手段或删规则。

## OMP 内置能力对照（不重造）

| mana 需求 | 采用能力 |
| --- | --- |
| 目标续航 | state.json + `mana-heartbeat.sh` 心跳为唯一权威；OMP goal runtime 仅为便利层（暴露 goal tool 时 arm） |
| Pi lane dispatch | `herdr worktree create` + `herdr agent start --kind pi` |
| pig lane dispatch（可选线路） | 同 `herdr worktree create`；pane split 带 `--env MANA_WORKER=1` 后 `herdr pane run <pane> pig -a`（herdr 无 pig kind，走 pane API，不用 named agent） |
| 工人线路与模型 | 不传 `--model` 顺势吃 pi 默认；`herdr agent get` → session jsonl 首条 `model_change` 回读取证写 `state.lanes[].model`；pig 取证扫 `~/.pig/agent/sessions` 最新一份（`agent_session` 恒为 null），同口径 |
| worktree 隔离 | Herdr worktree workspace / Git worktree |
| 工人打回、状态、确认 UI | `herdr agent prompt/get/read/wait/send-keys` |
| pig 打回、等待、needs_input | `herdr pane send-text`+`send-keys enter`（`agent prompt/send-keys` 对 pig 报 `agent_not_ready`）；wait 用 `--until working`/`--until done`（`--until idle` 不作完成信号）；needs_input 只认 `BLOCKED:`/`QUESTION:`/`RECOMMENDED:` 文本协议 |
| 工人不阻塞（提问/危险命令/审查门） | `MANA_WORKER=1`（pane `--env`）+ `extensions/pi/{mana-worker,safe-guard,precommit-review}.ts` |
| orchestrator 不阻塞（方案选择） | 技能规则自决 + `ask: {timeout: 30}` 兜底 |
| 工人回收 | `herdr pane close` + agent/pane `not_found` 双验证（pi/pig 两线路同一命令与判定） |
| 监督循环 | state.json + Herdr agent 状态 |
| 状态文件 | 持锁 shell 内原子替换主仓 `.mana/<run-id>/state.json`，禁止直接 `write` 工具 |
| OMP 角色 | 当前 orchestrator；不用 OMP subagent 代替 Pi worker |

## 自检

每次 run 结束前断言：state.json 每个 lane status ∈ `reclaimed|blocked|failed|landed`；每个 landed lane 能给出授权范围、命中的 `tier_grant` 与其守卫命令输出、goal 终态、PR 号、tier 判定、验收命令输出、Pi pane 回收证据七者，否则 run 不算完成。
另断言：每条 lane 的 pane 创建命令含 `--env MANA_WORKER=1`、`herdr agent start` 命令**不含** `--model`、`state.lanes[].model` 记有 session 首条 `model_change` 实测线路；发生重派的 lane 能给出 `attempt`、`superseded_by_agent` 与旧 pane 回收双 `not_found` 证据；run 期间零人工确认 UI（若出现，state 里有对应 `blocker` 与原文）；每轮工人 `BLOCKED:` 都有 `QUESTION:`/`RECOMMENDED:` 与 orchestrator 的自决记录。含 pig lane 时另断言：pane 创建命令含 `--env MANA_WORKER=1`（与 pi 同）、`herdr pane run` 命令**不含** `--model`、`state.lanes[].model` 记有 `~/.pig/agent/sessions` 最新会话首条 `model_change` 实测 `provider/modelId`、回收后 `agent get` 与 `pane get` 双 `not_found`。
