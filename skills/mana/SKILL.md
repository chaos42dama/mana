---
name: mana
description: "OMP orchestrator + Herdr Pi 工人的自主工程流程（/mana）。支持 intake、上下文重建（how/why/teach/recall）与授权后的 Pi lane 自主执行、验收、PR、CI、merge、清理。Triggers: /mana, mana, 自主编排, Pi subagent, 自主 landing, /mana how, /mana why, /mana teach, /mana recall。"
---

# /mana — OMP 自主编排

`/mana` 有三个互斥入口：**context** 只读重建上下文；**intake** 把模糊目标收敛为可验收的 Issue；**run** 只在负责人（下称 CTO）对该 Issue 明确授权后，由当前 OMP session 作为 orchestrator，调度 Herdr 专属 pane 内的 **Pi** 工人完成 dispatch → supervise → verify → land → reclaim。

> 本技能假定运行环境为 **OMP（oh-my-pi）+ Pi 编码 agent + herdr**，不兼容其它 agent 宿主。

## §0 不变量（违反即停）

1. **state 是唯一事实源**。状态存 `<repo>/.mana/<run-id>/state.json`（`.git/info/exclude` 排除 `.mana/`）。每次监督 sweep 先重读，再原子重写。会话记忆不可信。
2. **DONE 是 claim 不是 verdict**。工人报完成后，orchestrator 必须亲自重跑该 lane 的验收命令，通过才信。
3. **代码 lane 必须 worktree 隔离并由 Pi 执行**。用 `herdr worktree create` 创建本 run 工作区，在其专属 pane 执行 `herdr agent start <name> --kind pi`；不得用 OMP `task`/`workpool` 充当代码工人。只读 lane 同样优先 Pi pane；只有一次性无会话调查才可用 OMP `scout`。
4. **lane 永不 push/merge**。发布权只在 orchestrator。
5. **永不 force-push、永不碰非本 run 创建的分支/worktree/会话**。
6. **一次授权覆盖已批准的 run，tier 由机器判定**。state 写入 `authorization: {issue, approved_at, scope, autonomous_landing: true|false, tier_grants: [{patterns: [路径 glob], max_tier, guard, approved_at}]}`。
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
   - 因此 lane 内的 VCS 变更、提交和本地 branch 清理应直接执行；不得把 Herdr `blocked` 当常规控制流。**run 中若仍出现确认 UI，视为配置漂移**：orchestrator 先 `get/read` 查因（首要检查 pane 内 `printenv MANA_WORKER` 是否为 `1`），记录原文并在 state 记 `blocker`；只有当屏幕命令、目标和影响完全匹配 state 中已批准 lane 的本地 worktree 操作时才 `herdr agent send-keys <name> enter`。远端删除、push/merge、共享只读资源、密钥、认证、支付、main/DBA 重写一律 `blocked`。不得盲发 `enter`；宿主强制阻止的确认不是可绕过的授权门，必须记录其原文并上报。
8. **Pi worker 必须回收**。lane 验收后，orchestrator 关闭它创建的专属 pane：`herdr pane close <pane-id>`；随后 `herdr agent get <name>` 和 `herdr pane get <pane-id>` 必须均为 `not_found`。未回收不得报告 run 完成。
9. **orchestrator 自身同样不得停在选择上**。自主 run 内：不调用 `ask`；需要决策时按同一条规则自决（有 `recommended` 取之，否则取自评最优首项），并把结论写进 `state.decision_log`；宿主兜底是 `~/.omp/agent/config.yml` 的 `ask: {timeout: 30}`（超时自动选中 recommended，无则首项；plan mode 下不生效）。只有 tier 判定/授权边界/§0.6 红线才上报 CTO，且一个 run 最多汇总问一次。

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
3. CTO 确认 Issue 和启动口令后，才进入 run。OMP 已启用 goal runtime；它用于维持已批准 run 的终态，不取代 intake 的需求澄清。

### context（不启动 lane、不写业务代码）

`/mana how <范围>`、`/mana why <范围>`、`/mana teach <范围>`、`/mana recall <主题>` 是高频上下文问答的最小等价入口，不另造四套项目技能。

1. **how**：以代码、运行命令、LSP 或 codebase-memory 为证据，说明当前架构、运行数据流、文件归属与边界；不把推测写成事实。
2. **why**：先锚定代码和提交，再并行查 git/jj log/blame、Issue/PR 评论、项目文档与可用运行证据；输出事实、合理推断、未知项及来源。
3. **teach**：复用 how 和 why 的证据，以中文分层解释“它是什么、怎样运作、为什么这样取舍”；涉及三项以上参与者时用递进图，不改代码。
4. **recall**：默认回看本仓最近七天的会话记忆、`.mana/*/state.json`、Issue/PR、分支和 worktree 现状，产出至多五条的当前状态、未决问题和唯一下一步；用户给出完整状态时不重复挖掘。
5. context 是只读入口。需要改动时转 intake；已有已授权 Issue 时转 run。不得在 context 静默派发 worker、修改 Issue 或扩大授权。

### run（已批准 Issue）

1. 读 Issue 全文与已有评论（forge CLI），确认已批准的子任务分解与授权范围：`autonomous_landing` 缺省为 `true`，仅 `--manual-landing` 时为 `false`，并写入 state；缺任一项 → 只回 intake，不 dispatch。
2. 把可检查的终态写入 state 的 `goal` 字段，并在当前 OMP runtime 暴露 `/goal` 或 goal tool 时同步 arm；未暴露时 state + Herdr 监督循环仍是权威续航机制。终态未满足不得因 worker 结束而停机。
3. 写 lanes 表进 state.json：`{run_id, base_ref, authorization{...,tier_grants}, goal, lanes: [{id, kind: readonly|code, target, acceptance: [命令或可观察断言], tier, tier_grant, guard_output, branch, workspace_id, pane_id, agent_name, status: planned|running|verifying|verified|reclaimed|landed|blocked|failed}]}`。`tier_grant` 记命中的 grant 索引，`guard_output` 记守卫命令的实际输出摘要。
4. 预检 `HERDR_ENV=1`、`herdr status`、Pi 入口、push/forge 认证/CI 通道，确认本 pane 已启用自主模式（`printenv MANA_AUTONOMOUS` 为 `1`，否则 safe-guard 会在 run 中途弹确认），确认工人侧三处扩展（§0.7）已装入 `~/.pi/agent/extensions/` 且三条 `*_SELFTEST=1 bun …` 全绿、`~/.omp/agent/config.yml` 含 `ask: {timeout: 30}`，并**先算 tier**：对每条 lane 的 `target` 路径跑 `check-mana-grant-scope.py --paths <paths> --allow-path ...`。未被 `tier_grants` 覆盖的 tier B lane 在这里一次性汇总上报 CTO（一个 run 最多问一次），获批后写入 `tier_grants` 再派发。缺任一预检项现在报，别等 N 条 lane 跑完。
5. 若新增 lane、扩大文件/路径边界或改变 acceptance，回 intake 更新 Issue 后重新获得一次 CTO 授权；不偷渡范围。

## §2 dispatch

- 每条需持续会话的 lane：先从当前 orchestrator pane 用 `herdr pane split --current --direction down --cwd <worktree-path> --env MANA_WORKER=1 --no-focus` 创建**下方横切**的本 run 专属 pane（`--env` 落在 pane 的 shell 上，pi 继承；不得用 `--direction right`）。读取返回的 `workspace_id`、`pane_id` 后，执行 `herdr agent start <agent-name> --kind pi --pane <pane-id> -- --exclude-tools ask_question`（`--` 之后是 pi 原生参数）。`<agent-name>` 和 branch 必须唯一，写入 state。
- 工人侧三处扩展（§0.7）由 `MANA_WORKER=1` 自动接管，brief **不再需要**逐条交代 `PI_SKIP_REVIEW=1` 之类的绕过技巧；brief 只写业务边界。
- Pi brief 用三段式（借 pi-crew 的 `goal/context/instructions`）：`goal` 一句话写完成态与判定方式；`context` 只放仓库里查不到的事实（CTO 已批准的范围与决策、lane 边界）；`instructions` 每条一个动作或一条禁令，末尾给停止条件。另需包含：逐条 acceptance 命令、文件/路径边界、禁触共享只读资源、禁 push/PR/merge/关闭自身 pane、禁运行 `/review` 与 `/end-review`、禁提问（要决策就自决并写入『决策』段）、交付格式。改动落在 `tier_grants` 内时，acceptance 必须包含一条 `python3 scripts/check-mana-grant-scope.py --base origin/main --allow-key <前缀>`，让工人在自己的 worktree 内先自证键范围。不得要求 worker 自开 PR、merge 或关闭自身 pane，也不得把决策委派给工人。
- 工人交付：完成所有工作后只输出一个机器可解析的最终状态行，且**首字符必须为** `DONE:` 或 `BLOCKED:`；随后可列证据（命令输出/路径/diff 摘要）。未出现该前缀的自然语言“完成”不是终态，orchestrator 必须 `read` 后追问，不得回收。
- 工人 `BLOCKED:` 后必须紧跟两行：`QUESTION:` 与 `RECOMMENDED:`（工人自评的建议项）。这是 needs_input 而不是失败：orchestrator 先在授权范围内按 `RECOMMENDED` 自决，写入 `state.decision_log`，再用 `herdr agent prompt` 把决定重投给同一工人（同一 lane 最多 2 轮，超限置 `blocked`）；只有决策触及 tier 判定/授权边界/§0.6 红线才上报 CTO。**不要在 run 中途把工人的问题原样转给 CTO**。
- `agent_prompt_stalled` 或 wait timeout 不代表未投递或失败；先 `herdr agent get/read`，不得重复 prompt。实际确认 UI 按 §0.7 裁决。

### 审批模式与真实授权门

- **真实的人为门是 `~/.omp/agent/extensions/safe-guard.ts`**（本仓库 `extensions/safe-guard.ts`），不是 OMP 内置审批：该扩展在 `tool_call` 钩子里匹配 `DANGEROUS_PATTERNS` 后调用 `ctx.ui.confirm("⚠️ Dangerous Command", ...)`，**完全不读 `tools.approvalMode`**，所以 yolo 拦不住它。
- 该扩展已加**启动时一次性授权**开关：`MANA_AUTONOMOUS=1`（或 `OMP_SAFE_GUARD=off`）时跳过 bash 危险命令确认，改为 `ui.notify` warning 审计；受保护路径（`.env`、`.git/`、`.ssh/`、`node_modules/`、`.omp/`）的确认与无 UI 时的硬阻断**不变**——密钥/认证红线不因自主模式放开。自检：`bun checks/safe-guard.check.mjs`（5 组断言：默认必确认、自主模式放行且通知、受保护路径仍拦、无 UI 硬阻断、pattern 回归）。
- 因此自主 run 的启动形态是 `MANA_AUTONOMOUS=1 omp`；建议把 `export MANA_AUTONOMOUS=1` 写进 `~/.bashrc` 作为默认，交互式 pane 天然满足，单次恢复人工确认用 `MANA_AUTONOMOUS=0 omp`。OMP 侧 `tools.approvalMode` 默认已是 `yolo`，`omp --approval-mode yolo` 只是显式化：**别把 yolo 当作 safe-guard 的开关**。策略优先用 `deny`/`bash.patterns` 拒绝危险命令，不要用 `prompt`——headless run 里 `prompt` 等于静默停摆。
- Pi 工人**没有**审批层：`@earendil-works/pi-coding-agent` bundle 内不存在 `approvalMode`/`autoApprove`，`hasUI`/`ui.confirm` 是扩展概念。但工人的交互门来自扩展，共三处，全部由 `MANA_WORKER=1` 关闭/降级（§0.7）：提问工具被封、危险 bash 只告警、`precommit-review` 整门关闭。带 `MANA_WORKER=1` 的 lane 停住只可能是 prompt 未投递、上下文或模型自报 `BLOCKED:`。
- `herdr agent prompt` 参数形态：`herdr agent prompt <TARGET> <TEXT> --wait --timeout <MS>`——位置参数必须在前、选项在后（写反报 `unknown option: <text>`）；`--timeout` 单位是**毫秒**且必须与 `--wait` 同用（否则报 `--timeout requires --wait`）。
- 结论：人为门只剩两处——(a) 宿主扩展的确认（OMP 侧用 `MANA_AUTONOMOUS=1`、Pi 工人侧用 `MANA_WORKER=1` 一次性关掉）、(b) `tier_grants` 覆盖不到的变更（§0.6）。不要把审批 UI 当授权门，也不要靠临场 `send-keys` 把 UI 顶过去。

## §3 监督循环

每轮 sweep：
1. 重读 state.json；对每条运行 lane 执行 `herdr agent get <name>`，必要时 `read`。
2. `DONE` 是 claim：orchestrator 重跑 acceptance 命令。通过后把实际输出写入 state，状态更新为 `verified`；失败则以 `herdr agent prompt` 打回修复，同一 lane 最多 2 轮，超限置 `blocked`。
3. 工人报 `BLOCKED:` → 按 §2 的 needs_input 规则自决并重投（≤2 轮）。若出现确认 UI（配置漂移）按 §0.7 查因裁决；仍不能自动放行的操作写入 state 的 `blocker` 并上报。
4. `verified` lane 立即 `herdr pane close <pane-id>`，再以 `agent get`、`pane get` 双 `not_found` 验证，状态置 `reclaimed`。不得关闭非本 run 创建的 pane。
5. 所有 lane 都为 `reclaimed|blocked|failed` 才进入 landing；不得因关闭 worker 而遗失 state 或验收证据。

## §4 landing（仅 orchestrator）

1. 仅对 `reclaimed` 且 acceptance 已记录通过的 code lane：orchestrator 在 state 登记的隔离分支提交、push；有冲突则在本 run worktree 解决并重验。
2. 使用 forge CLI（以 `gh` 为例）`gh pr create --head <branch> --base main "#<issue>: <summary>"` 组织全部成果。
3. 等 CI（如 GitHub Actions：`gh run list` / `gh run watch <run-id>`）与项目验收命令；失败则修复、重验，不能因“已授权”跳过。
4. merge 前对 PR 的真实 diff 复跑授权守卫，把命令与输出写进 state：`authorization.autonomous_landing=true` 且守卫 `exit 0` → 执行 squash merge（`gh pr merge --squash --delete-branch` / `fj pr merge -M squash -d`）；守卫非 0（越出 `tier_grants`）→ 不合并，按 §0.6 上报 CTO。`--manual-landing`（`autonomous_landing=false`）时，PR/CI 后上报 CTO。
5. PR merge 确认后，orchestrator 移除本 run worktree，删除本地/远端 feature branch，`git fetch --prune` 验证无残留；最后评论并关闭 Issue。

## §5 报告

全程证据与结论优先评论到对应 Issue（forge CLI）；最终报告含：授权范围、lane 表终态、每条验收实际输出、Pi pane 回收双 `not_found`、PR 号、CI、merge、worktree/branch 清理与后续建议。

## OMP 内置能力对照（不重造）

| mana 需求 | 采用能力 |
|---|---|
| 目标续航 | OMP goal runtime（可用时）+ state.json 监督循环 |
| Pi lane dispatch | `herdr worktree create` + `herdr agent start --kind pi` |
| worktree 隔离 | Herdr worktree workspace / Git worktree |
| 工人打回、状态、确认 UI | `herdr agent prompt/get/read/wait/send-keys` |
| 工人不阻塞（提问/危险命令/审查门） | `MANA_WORKER=1`（pane `--env`）+ `extensions/pi/{mana-worker,safe-guard,precommit-review}.ts` |
| orchestrator 不阻塞（方案选择） | 技能规则自决 + `ask: {timeout: 30}` 兜底 |
| 工人回收 | `herdr pane close` + agent/pane `not_found` 双验证 |
| 监督循环 | state.json + Herdr agent 状态 |
| 状态文件 | `write .mana/<run-id>/state.json` |
| OMP 角色 | 当前 orchestrator；不用 OMP subagent 代替 Pi worker |

## 自检

每次 run 结束前断言：state.json 每个 lane status ∈ `reclaimed|blocked|failed|landed`；每个 landed lane 能给出授权范围、命中的 `tier_grant` 与其守卫命令输出、goal 终态、PR 号、tier 判定、验收命令输出、Pi pane 回收证据七者，否则 run 不算完成。
另断言：每条 lane 的 pane 创建命令含 `--env MANA_WORKER=1`；run 期间零人工确认 UI（若出现，state 里有对应 `blocker` 与原文）；每轮工人 `BLOCKED:` 都有 `QUESTION:`/`RECOMMENDED:` 与 orchestrator 的自决记录。
