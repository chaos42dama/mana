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

- scripts/mana-run-lock.py、scripts/check-mana-grant-scope.py、scripts/check-mana-issue.py（intake Issue 骨架校验）、scripts/mana-selftest.sh（全仓自检入口，预检 d 门回归面）属 run 基础设施，改动须单独授权。

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
| 回归面手工枚举漏项 | `checks/all.check.mjs` 单命令覆盖（全部契约 check × 两种模式一次跑完，不早退） | #57 |
| `/mana architect` 的多线路设计入口与两份 references 不得被静默删改 | `checks/mana-architect-contract.check.mjs`（8 组断言）+ `scripts/mana-install.sh`（references glob 映射） | #55 |
| 默认线漂移（settings 默认线 ≠ run `state.worker_model`；run 期间默认线不得切换） | `scripts/mana-preflight.sh` 线路门（三态冒烟 healthy/capacity/unavailable + drift FAIL，fail-closed，只读）+ `checks/mana-preflight-line.check.mjs`（四场景 + `--self-test` 负例：删容量信号/删 drift 判定必须失败） | #73 |

新增检查请登记到本表（文件名 + 断言范围），防 drill 失传。
