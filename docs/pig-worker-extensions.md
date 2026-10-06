# pig 下 mana 工人侧四扩展真机复核（run-38）

复核日期：2026-10-05。pig 0.4.0+1.0.0（Go 宿主 + Pi 规范 TS 扩展兼容运行时），herdr pane 注入 `--env MANA_WORKER=1`，模型 space-bunny-free，上下文 1.0M。四个 TS 扩展由 pig 自动发现（无需 `-e`），启动屏 Extensions 列表实证：`herdr-agent-state.ts, mana-worker-compact.ts, mana-worker.ts, precommit-review.ts, safe-guard.ts`。

## 结论速查表

| 扩展 | 结论 | 一句话 |
| --- | --- | --- |
| mana-worker.ts | 一致 | 扩展加载、session_start notify 可见；pig 仅 4 工具（read/bash/edit/write）无提问类工具，封禁表空转但机制在位 |
| safe-guard.ts | 一致 | 危险 bash 只 notify 不弹窗（toast 实拍可见、pane 不阻塞）；受保护路径 `.env`/`.ssh/` 硬 block、reason 回灌 |
| precommit-review.ts | 一致 | `git commit` 不拦不排队 `/review`（commit bccceb7 落盘，pane 无任何 review UI） |
| mana-worker-compact.ts | 一致 | `/compact` 触发真实压缩，session jsonl 出现 `"fromHook": true` 的 compaction，summary 含工人协议块+原始 brief |

**补丁：无。** 四条全部一致，未改任何 `extensions/pi/` 源码。

## API 依赖清单（源码通读）

| 扩展 | 事件 | 宿主/UI 调用 | pig 文档支持 |
| --- | --- | --- | --- |
| mana-worker.ts | `session_start`, `tool_call` | `ctx.ui.notify?.()` | 两者均有（实测见下） |
| safe-guard.ts | `tool_call` | `ctx.ui.notify?.()`, `ctx.ui.confirm`(仅非工人), `ctx.hasUI`, `ctx.cwd` | `tool_call` 权限门见 pig docs/mcp.md:272 |
| precommit-review.ts | `tool_call` | `ctx.ui.notify?.()`, `pi.sendUserMessage`(仅非工人拦截时) | 未触发（工人门关闭） |
| mana-worker-compact.ts | `session_before_compact` | 无 UI，返回 `SessionBeforeCompactResult` | pig docs/events.md:45，"A handler can cancel compaction or provide the compaction result. PiG persists a provided result" |

## 逐条验证记录

每条一块独立 TPANE（`herdr pane split --current --direction down --ratio 0.4 --cwd /tmp/mana-pig-tN --env MANA_WORKER=1 --no-focus` → `herdr pane run <pane> pig -a` → `herdr pane send-text` + `send-keys enter` → `herdr pane read`），用完即 close。

### 1. mana-worker.ts — 一致

**观测 A：扩展加载 + session_start notify**。`herdr pane read w2W:p4` 启动屏：

```
[Extensions]
  herdr-agent-state.ts, mana-worker-compact.ts, mana-worker.ts, precommit-review.ts, safe-guard.ts
 Warning: MANA_WORKER=1：交互式提问已禁用，提交不触发 pi-review（自主 lane）
```

**观测 B：pig 工具清单（提问类封禁对象探测）**。pane 内询问工具列表，pig 回答：

```
我当前可用的工具（全部 4 个）：
 read / bash / edit / write
接下来关于 ask_question：该工具在我的工具集中不存在，我无法调用它
```

pig 无内置/注册提问类工具，`INTERACTIVE_TOOLS` 封禁表在 pig 下空转（与 pi 0.84+ 同状况，代码注释已预告）。封禁逻辑本身为纯函数，SELFTEST 覆盖。

**观测 C：tool_call 钩子机制在 pig 下工作**（brief 预授权的退路）。同一 pane 内跑 `chmod 777 dummy2`（命中 safe-guard 的 `tool_call` handler），pig 回合正常完成；且 mana-worker 自身的 `tool_call` handler 对 bash/write 全程未误拦（观测 A/B/C 的工具调用全部放行执行）。同事件、同注册机制（`pi.on("tool_call")`）已实证可用。

处置：不改代码。

### 2. safe-guard.ts — 一致

**观测 A：危险 bash 只 notify 不弹窗**。pane 内 `chmod 777 guard.txt`（文件已建，pattern 命中 `chmod 777`），发送后每秒抓 `herdr pane read`：

```
HIT@3s:  Warning: ⚠️ safe-guard 工人模式放行（无人工确认）：cd /tmp/mana-pig-t2 && chmod 777 guard.txt; echo
```

20 秒后 toast 消失（footer toast 为瞬态，session_start 的 banner 因无覆盖而持久可见）；pane 全程无确认 UI，`herdr agent get w2W:p5` → `"agent_status":"done"`，回合无阻塞。

**观测 B：受保护路径硬 block**。同 pane 内令 pig `write .env` 与 `edit /home/zoomq/.ssh/known_hosts`，pig 复述：

```
拦截 reason（原样）：Protected path: .env
拦截 reason（原样）：Protected path: .ssh/
两步都被拦截，文件均未创建/修改。
```

文件系统复核：`/tmp/mana-pig-t2/` 无 `.env`（仅 guard.txt），`/home/zoomq/.ssh/` 为空目录、known_hosts 不存在——block 前未落盘。

处置：不改代码。备注：`ctx.ui.notify` 在 pig 下可用，但 toast 瞬态（约 15-20s），pane 抓屏需在工具调用后数秒内进行；orchestrator 若依赖该 toast 做验收，应 `wait-output` 或连拍而非事后单次 read。

### 3. precommit-review.ts — 一致

夹具：`/tmp/mana-pig-t3` git 仓库（init commit ac25e17）。pane 内令 pig `edit a.txt` 后 `git add -A && git commit -m "t3"`：

```
父提交 │ ac25e17 init │ 变更 │ a.txt 1 file changed │ 工作区 │ 干净
```

```bash
$ cd /tmp/mana-pig-t3 && git log --oneline
bccceb7 t3
ac25e17 init
```

commit 真实落盘、未被拦；pane 全程无 `/review` 队列提示、无 `select` UI；`workerNoticeSent` 的「MANA_WORKER=1：跳过 pre-commit 审查门」notify 属同款瞬态 toast（可见性已由扩展 2 实证）。非工人路径（拦截+排队 `/review`）pig 侧未验，由 SELFTEST 回归断言覆盖（工人门整门关闭不依赖 UI）。

处置：不改代码。

### 4. mana-worker-compact.ts — 一致（真实压缩一次）

夹具：`/tmp/mana-pig-t4`。流程：投递含特征串 `T4-COMPACT-PROOF` 的 brief → 令 pig cat 三个大文件（CHANGELOG.md 等，共 ~550KB）把会话撑到 60,814 tokens → 发送 `/compact` → pane 显示：

```
[compaction]
 Compacted from 60,814 tokens (ctrl+o to expand)
```

session jsonl（`~/.pig/agent/sessions/--tmp-mana-pig-t4--/2026-10-05T01-02-48-*.jsonl`）出现 compaction entry，关键字段：

```json
{"type": "compaction", "id": "a33674c0", "summary": "【MANA 工人协议】MANA_WORKER=1 生效中\n- 交互提问已禁用：…\n- 最终交付首字符必须是 DONE: 或 BLOCKED:…\n\n【原始 brief】\nT4-COMPACT-PROOF brief：你的任务是在 /tmp/mana-pig-t4 下创建文件 proof.txt 写入 ok。…\n", "firstKeptEntryId": "9aea9ca8", "tokensBefore": 60814, "fromHook": true, ...}
```

- `"fromHook": true` — 压缩结果来自扩展接管（pig 原生标记），非默认摘要；
- summary 七条工人协议完整在位，原始 brief 特征串完整；
- `firstKeptEntryId`/`tokensBefore` 沿用 preparation。

**采纳的行为证据**：压缩后问 pig「凭记忆回答原始 brief 特征串与交付首字符要求」，回答：

```
Answer from memory: feature string T4-COMPACT-PROOF; first char DONE: or BLOCKED:.
原始 brief 的特征串：T4-COMPACT-PROOF。
```

处置：不改代码。

## 补丁说明

无需补丁。四条在 pig 下的行为与 pi 一致；无一处需要 pig 专属分支。

一条运维备注（非代码问题）：在 MANA_WORKER=1 的工人 pane 里直接跑 `PI_PRECOMMIT_SELFTEST=1 bun extensions/pi/precommit-review.ts` 会 FAIL（「未审查 → 拦截」），原因是 `decideCommit` 默认参读进程 env，工人 pane 本身 MANA_WORKER=1。`scripts/mana-preflight.sh` 自检门已用 `env -u MANA_WORKER` 剥掉工人态（源码注释明示），人工复核须沿用同款方式，属已知设计而非回归。

## 对 SKILL pig 分支的影响

仅记录，不改 SKILL.md：

1. pig 分支的扩展自动发现、`--env MANA_WORKER=1` 注入、四扩展行为均可照旧声明，本次为「逐个可用」提供了实测背书（对照 #33 官方 herdr pi 集成静默失效的反例）。
2. 若 SKILL 提到压缩保真验证：pig 下触发真实压缩的现成手段是 `/compact`（会话 >~60k tokens 时）；更小的会话报 `Compaction failed: Nothing to compact (session too small)`。
3. safe-guard / precommit 的 `ctx.ui.notify` toast 在 pig 下瞬态（约 15-20s），orchestrator 验收 pane 通知需连拍或 `wait-output`，不能事后单次 `pane read`。

## 验证后置检查（本 run 执行记录）

- 四条 SELFTEST + safe-guard check 全绿（`env -u MANA_WORKER` 下实跑，与 preflight 自检门同款）：
  - `mana-worker selftest OK`（8 ok）
  - `safe-guard selftest OK`（7 ok）
  - `precommit-review selftest OK`（10 ok）
  - `mana-worker-compact selftest OK`（17 ok）
  - `✓ safe-guard 自主模式校验通过（5 组断言）`
- `~/.pig/agent/extensions/` 四份与仓内 `cmp` 全等（复核前后各一次，详见 commit 记录）；
- `~/.pi/agent/extensions/` 未触碰（本 run 全程无指向该目录的写操作；可用 `ls -la --time-style=full-iso ~/.pi/agent/extensions/*.ts` 对照本 run 起始时间戳确认 mtime 未变）；
- 四块 TPANE（w2W:p4/p5/p6/p7）已全部 close，`herdr pane list` 无 pig agent 残留。

> 安装与验证的最新口径见 README「pig 工人线路(可选)」节:`bash scripts/mana-install.sh` 已纳入 pig 侧扩展(条件安装),验证用 `bash scripts/mana-preflight.sh`;本文手工 cp 命令仅作历史记录,已被脚本取代。
