# AGENTS.md — chaos42dama/mana

## 受保护分支

- main：禁 force-push、禁删除；只经 PR squash merge 落地。

## 只读上游区

- 无。

## tier_grants 红线

- scripts/check-mana-grant-scope.py 守卫契约（--self-test / --paths / --base+--allow-key）不得在 run 内修改、放宽。
- 本仓无 toml；grant 中 --allow-key never. 仅为满足守卫 CLI，不授权任何 toml 键。
- 未被 patterns 覆盖的路径 = tier B，§1.4 预检停，不派发。

## run 基础设施

- scripts/mana-run-lock.py、scripts/mana-run-audit.py（收尾锁审计，只读）、scripts/check-mana-grant-scope.py、scripts/check-mana-issue.py（intake Issue 骨架校验）、scripts/mana-selftest.sh（全仓自检入口，预检 d 门回归面）属 run 基础设施，改动须单独授权。

## 规则 ↔ 强制手段 ↔ 首次发现 run

规则已存在但无强制手段 = 重复发生；发现此类规则必须同一变更补齐强制手段或删规则（来源：SKILL.md §5 run 后复盘，mistake class 同关键词出现两次以上才入表）。

| 规则 | 强制手段（脚本/检查/CI/测试） | 首次发现 run |
| --- | --- | --- |
| lane 出现确认 UI / `MANA_WORKER` 未生效 | `PI_*_SELFTEST` + `scripts/mana-preflight.sh`（`precommit-review` 整门关闭） | #11 |
| 工人 brief 漏写禁令导致打回 | §2 合并 brief 模板（全文逐字一次投齐，禁止「同前」） | #28 |
| 守卫未实跑就 merge | §4.4 merge 前对真实 diff 复跑 `scripts/check-mana-grant-scope.py` | 首发（run 号不可考） |
| 工人线路被 `--model` 锁死回流 | §2「不带 `--model`」禁令 + dispatch 文本断言；`checks/mana-orchestrator-contract.check.mjs`（断言所有 `agent start` 命令模板不含 `--model` + §5 自检断言句在位） | #20 |
| verdict 绑定 `head_sha`，新 commit 作废旧结论 | `checks/mana-verdict-ledger.check.mjs`（结论 + head 绑定断言） | #24（复发 #29） |
| 工人交付后工作树残留格式化脏改动（pi-lens deferred format） | `checks/mana-worker-hygiene.check.mjs`（§2 洁净契约 + §3 脏树不绑 `head_sha` 不判 `verified`） | #24（复发 #27/#29，一类三次） |
| 契约无常驻 drill，drill 随 run 结束失传 | drill 常驻在 `checks/*.check.mjs --self-test`（#31 起） | #28（复发 #29） |
| herdr/gh CLI 参数形态误用 | §2 参数形态说明 + `checks/mana-orchestrator-contract.check.mjs`（CLI 形态断言：agent prompt/agent wait/pane split/agent start） | #27 |
| `--wait` 超时被误当未投递 | §2「先 `agent get/read` 取证，不得重复 prompt」+ `checks/mana-orchestrator-contract.check.mjs`（超时 ≠ 未投递断言） | #24（复发 #27/#28/#29） |
| 用 fifo/管道喂命令建持锁会话，留下握锁孤儿；收尾只用 `pgrep -af 'mana-run-lock'` 判净（exec 后 cmdline 无脚本名 ⇒ 假阴性） | §0 持锁入口禁 fifo + `scripts/mana-run-audit.py`（按锁 inode 扫 `/proc/*/fd`）+ §4 第 6 步收尾必跑 + `checks/mana-run-teardown.check.mjs`（真进程 drill：`--self-test` 复现孤儿，断言 pgrep 0 命中而审计 DIRTY，kill 后转 CLEAN） | nrc#3 |
| 回归面手工枚举漏项 | `checks/all.check.mjs` 单命令覆盖（全部契约 check × 两种模式一次跑完，不早退） | #57 |
| `/mana architect` 的多线路设计入口与两份 references 不得被静默删改 | `checks/mana-architect-contract.check.mjs`（8 组断言）+ `scripts/mana-install.sh`（references glob 映射） | #55 |
| 默认线漂移（settings 默认线 ≠ run `state.worker_model`；run 期间默认线不得切换） | `scripts/mana-preflight.sh` 线路门（三态冒烟 healthy/capacity/unavailable + drift FAIL，fail-closed，只读）+ `checks/mana-preflight-line.check.mjs`（四场景 + `--self-test` 负例：删容量信号/删 drift 判定必须失败） | #73 |
| `/mana veri` 契约漂移（三口/canonical/写界/五步/六节/账本四键/命令含 `--model` 等被删改） | `checks/mana-veri-contract.check.mjs`（无参断言 SKILL.md veri 条目 + 两份 references；`--self-test` 负例：删「cleanup 后证据仍在」/命令模板插 `--model` 必须失败） | run-79-veri-init-20261013 |

| `echo` 讨论步进盖楼与 `MANA_ECHO_LIVE=1` 门控（方案 A 粒度、非阻断降级、`decisions.tsv` 与会话 JSONL 蒸馏） | `scripts/echo-discussion-sink.py` + `scripts/mana-heartbeat.sh` + `checks/mana-echo-sink.check.mjs`（无参契约断言 + `--self-test` 合成 drill 与负例） | ipi#224 |
| 执行期黑盒与死循环/越界写（连续 3 次报错反射、连续 6 次 `stalled_loop`、`MANA_LANE_ALLOW_PATHS` 事前拦截、多 lane 共享契约与 handoff） | `extensions/pi/mana-worker.ts` + `scripts/check-mana-issue.py` + `checks/mana-worker-reflex.check.mjs`（无参契约断言 + `--self-test` 合成 drill 与负例） | ipi#224 |
| 契约检查继承父环境 `MANA_REPO`/`MANA_RUN_ID`（合成线路被真实 run state 误杀，假红；A 项 BASE_ENV 隔离） | `checks/mana-preflight-line.check.mjs` + `checks/preflight-pig-gate.check.mjs`（构造合成环境时剥离 run 指针 + 回归断言） | #108 |
| decisions.tsv 与 state.decision_log 不同源（两处都可当"全部决策"来读，假绿；tsv 为权威源） | `scripts/mana-sync-decisions.py`（--check 只比对 + 原子重建）+ `checks/mana-decisions-sync.check.mjs`（无参契约断言 + `.mana` 实盘审计 + `--self-test` drill 与负例）+ SKILL §4 收尾必跑 | #108 |
| 依赖 `.mana/` 实盘数据的契约在 worktree 里假绿（`.mana/` 被 ignore 不存在 → 审计静默跳过却宣称通过，合入主干才红） | `checks/mana-decisions-sync.check.mjs`（无 `.mana/` 时打 `SKIP` 并在末行报审计 run 数）；此类契约必须在正本仓验证，不得只在 lane worktree 跑 | #108（同 run 复发一次：PR #110 → #111） |

新增检查请登记到本表（文件名 + 断言范围），防 drill 失传。
