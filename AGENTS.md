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
| 工人被**不属任何门禁**的宿主工具告警驱动，反复"修"不存在的错误（pi-lens 把 Makefile 归为 shell 并派 shellcheck，报 `2 blocking`；而 `make lint` 只查 `*.sh`，实测一直 clean）→ nrc `nrc-9-live` 空转 70+ 分钟零提交 | `checks/mana-gate-attribution.check.mjs`（§0.10 三步判读 + §2 brief 真门禁清单，5 条负例真失败）+ `scripts/patch-pilens-makefile.py`（治标：runner 按扩展名早退 + `Makefile` 归 `kind="make"`，由装机调用） | #124 |
| 契约无常驻 drill，drill 随 run 结束失传 | drill 常驻在 `checks/*.check.mjs --self-test`（#31 起） | #28（复发 #29） |
| herdr/gh CLI 参数形态误用 | §2 参数形态说明 + `checks/mana-orchestrator-contract.check.mjs`（CLI 形态断言：agent prompt/agent wait/pane split/agent start） | #27 |
| `--wait` 超时被误当未投递 | §2「先 `agent get/read` 取证，不得重复 prompt」+ `checks/mana-orchestrator-contract.check.mjs`（超时 ≠ 未投递断言） | #24（复发 #27/#28/#29） |
| 用 fifo/管道喂命令建持锁会话，留下握锁孤儿；收尾只用 `pgrep -af 'mana-run-lock'` 判净（exec 后 cmdline 无脚本名 ⇒ 假阴性） | §0 持锁入口禁 fifo + `scripts/mana-run-audit.py`（按锁 inode 扫 `/proc/*/fd`）+ §4 第 6 步收尾必跑 + `checks/mana-run-teardown.check.mjs`（真进程 drill：`--self-test` 复现孤儿，断言 pgrep 0 命中而审计 DIRTY，kill 后转 CLEAN） | nrc#3 |
| 回归面手工枚举漏项 | `checks/all.check.mjs` 单命令覆盖（全部契约 check × 两种模式一次跑完，不早退） | #57 |
| `/mana architect` 的多线路设计入口与两份 references 不得被静默删改 | `checks/mana-architect-contract.check.mjs`（8 组断言）+ `scripts/mana-install.sh`（references glob 映射） | #55 |
| 默认线漂移（settings 默认线 ≠ run `state.worker_model`；run 期间默认线不得切换） | `scripts/mana-preflight.sh` 线路门（三态冒烟 healthy/capacity/unavailable + drift FAIL，fail-closed，只读）+ `checks/mana-preflight-line.check.mjs`（四场景 + `--self-test` 负例：删容量信号/删 drift 判定必须失败） | #73 |
| `/mana veri` 契约漂移（三口/canonical/写界/五步/六节/账本四键/命令含 `--model` 等被删改） | `checks/mana-veri-contract.check.mjs`（无参断言 SKILL.md veri 条目 + 两份 references；`--self-test` 负例：删「cleanup 后证据仍在」/命令模板插 `--model` 必须失败） | run-79-veri-init-20261013 |

| `echo` 讨论步进盖楼与 `MANA_ECHO_LIVE=1` 门控（方案 A 粒度、非阻断降级、`decisions.tsv` 与会话 JSONL 蒸馏） | `scripts/echo-discussion-sink.py` + `scripts/mana-heartbeat.sh` + `checks/mana-echo-sink.check.mjs`（无参契约断言 + `--self-test` 合成 drill 与负例） | ipi#224 |
| `echo` 守护不得空烧 CPU（未开 live 不起守护；session 级增量解析；单 tick 解析预算 + 单文件上限） | `scripts/echo-discussion-sink.py`（`watch_repo` live 门控 + 字节偏移增量水位 `.mana/echo-parse/<id>.json` + `MANA_ECHO_TICK_BUDGET_BYTES`/`MANA_ECHO_MAX_FILE_BYTES`）+ `checks/mana-echo-sink.check.mjs`（断言三闸门 + 负例 + live 门控/增量 drill） | #128 |
| 执行期黑盒与死循环/越界写（连续 3 次报错反射、连续 6 次 `stalled_loop`、`MANA_LANE_ALLOW_PATHS` 事前拦截、多 lane 共享契约与 handoff） | `extensions/pi/mana-worker.ts` + `scripts/check-mana-issue.py` + `checks/mana-worker-reflex.check.mjs`（无参契约断言 + `--self-test` 合成 drill 与负例） | ipi#224 |
| 契约检查继承父环境 `MANA_REPO`/`MANA_RUN_ID`（合成线路被真实 run state 误杀，假红；A 项 BASE_ENV 隔离） | `checks/mana-preflight-line.check.mjs` + `checks/preflight-pig-gate.check.mjs`（构造合成环境时剥离 run 指针 + 回归断言） | #108 |
| decisions.tsv 与 state.decision_log 不同源（两处都可当"全部决策"来读，假绿；tsv 为权威源） | `scripts/mana-sync-decisions.py`（--check 只比对 + 原子重建）+ `checks/mana-decisions-sync.check.mjs`（无参契约断言 + `.mana` 实盘审计 + `--self-test` drill 与负例）+ SKILL §4 收尾必跑 | #108 |
| 依赖 `.mana/` 实盘数据的契约在 worktree 里假绿（`.mana/` 被 ignore 不存在 → 审计静默跳过却宣称通过，合入主干才红） | `checks/mana-decisions-sync.check.mjs`（无 `.mana/` 时打 `SKIP` 并在末行报审计 run 数）；此类契约必须在正本仓验证，不得只在 lane worktree 跑 | #108（同 run 复发一次：PR #110 → #111） |
| drill 暂存目录必须落 `tmpdir()` 且按进程隔离；落在仓库内固定路径 = 并发假红 + 残留污染工作树 | `checks/preflight-pig-gate.check.mjs`（`mkdtempSync(tmpdir())` 父目录 + 每次 `setupEnv()` 新建 `env-` 子目录）；并发 drill：`for i in 1 2 3 4; do (node checks/preflight-pig-gate.check.mjs >/tmp/par$i.log 2>&1; echo "run$i=$?") & done; wait` 须 4 组全 `runN=0` | #108 |
| 仓根未跟踪文件被当成「无害残留」：一旦 `git add` 即进装机镜像（跟踪集覆盖全部仓根文件），既让 `mana-install.check.mjs` 失败，又把工具残留装进全局技能目录 | `checks/mana-install.check.mjs`（`主镜像源覆盖正本跟踪集` 断言：仓根新增被跟踪文件即失败）+ 本节处置口径 | #118 |
| herdr 官方 pi 集成 `~/.pi/agent/extensions/herdr-agent-state.ts`（`herdr integration install pi` 投放、带 `HERDR_INTEGRATION_ID=pi` 托管头）与仓内 `extensions/pig/herdr-agent-state.ts` 同名不同物，合并任一方向即静默破坏对应线路状态上报 | `checks/mana-install.check.mjs` 的 `assertHerdrIntegrationOwnership`（映射表不得含官方路径、pig 版不得伪装托管头、pig 版走 `report-agent`）+ `--self-test` 负例(c)(d)(e) | #118 |
| `~/.pi/skills/` 不是 pi/omp 的 skill 根（pi 1.5.2 只读 `~/.pi/agent/skills` 与 `~/.agents/skills`；pig 读 `~/.agents/skills`），旧装机规则残留的副本永不被加载却停在旧版，会让「在用指令集是否最新」判断失真 | `checks/mana-install.check.mjs`（装机脚本不得出现 `.pi/skills/`）+ 实测判据：`~/.agents/skills/mana/SKILL.md` 与正本 `sha256` 相等 | #118 |
| pig lane 工人侧四扩展未装机（#120）：pig 只从 `$PIG_HOME/agent/extensions` 与受信 `.pig/extensions` 加载、**永不读 `~/.pi`**（pig docs D2）；只装 herdr 自报扩展时工人协议四份对 pig 不可见，而 pig 门只查 herdr 那条会照报绿（假绿） | `scripts/mana-install.sh`（四条 cond 映射，同一循环声明）+ `scripts/mana-preflight.sh` pig 门（五份在位硬 FAIL + 四份 `cmp` 漂移 WARN）+ `checks/mana-install.check.mjs`（映射/README 目标集/负例(f)(g)）+ `checks/preflight-pig-gate.check.mjs` 组3b（漏一份必 FAIL 并点名） | #120 |
| `pig status` 的 `health` 字段不可作扩展加载判据：对语法错误的扩展仍报 `health=''`、`enabled=true`；判断「扩展真的可用」只能靠 preflight 门的在位+cmp+自检实跑，或 pig lane 内实跑 | `scripts/mana-preflight.sh` pig 门（在位 + `cmp -s` + `reportArgs` 自检）；README pig 节明示该字段不可用 | #120 |
| 契约 check 继承宿主 `MANA_*` 环境，同一 check 在不同宿主上结论不同（`MANA_SRC=/tmp` 假红、`MANA_PREFLIGHT_SKIP_SMOKE=1` 假绿、`MANA_SELFTEST_ACTIVE=1` 静默跳过） | `checks/all.check.mjs` 子进程环境白名单（只透传 `PATH/HOME/…/NODE_*/BUN_*`）+ 三个预检调用方剥离 `MANA_SRC`/`MANA_PREFLIGHT_SKIP_SMOKE` + `checks/mana-drill-env.check.mjs`（静态契约 + `--self-test` 真进程 drill 与污染注入负例） | #117 |
| 环切断依赖的环境变量被环境隔离机制剥掉 → `preflight→selftest→all.check→line-check→preflight` 无限递归；且嵌套态下 `--force-contracts` 被静默 SKIP 后报 0（假绿） | `checks/all.check.mjs` 显式单点透传 `MANA_SELFTEST_ACTIVE`（非宿主污染面，是调用链守卫）+ `scripts/mana-selftest.sh` 嵌套态 `FORCE=1` 判 FAIL + `scripts/mana-preflight.sh` 按嵌套上下文决定是否传 `--force-contracts` + `checks/mana-drill-env.check.mjs`（组4/5/6 + `--self-test` 断言嵌套 force 真非 0、无 force 仍 SKIP+0） | #117 |

新增检查请登记到本表（文件名 + 断言范围），防 drill 失传。
