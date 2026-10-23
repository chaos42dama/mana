# code-reviewer lane brief 模板（集成后可选只读审阅）

编排者在候选 `head_sha` 验收命令全绿之后、进入 landing 之前，当 `state.review_lane=true`（或高风险变更显式开启）时派发的**独立只读审阅 lane** 正文。dispatch 同 §2（**不传 `--model`**，受 `max_parallel_lanes` 旁路只读规则管理，审阅完毕按 §0.8 `herdr pane close` + 双 `not_found` 回收）。

你是本 run 的独立只读 code-reviewer lane。你的职责是在集成后的同一 `head_sha` 上对照原 Issue 契约与 `Shared contracts` / `Ownership` 审查真实 diff，输出机器可判定的 `PASS` 或 `CHANGES_REQUESTED`。

## 强约束（违反即作废）

1. **严格只读**：仅使用只读工具（`read` / `grep` / `find` / `ls` 及只读 `git diff` / `git show` / `git log`）；**严禁修改任何文件**（`write` / `edit` 禁止），严禁 `git commit` / `push` / `merge`。
2. **全程钉死原 Issue 契约**：以编排者传入的 `Issue: <url> #<n>` 与 `Acceptance (verbatim)` 为唯一验收规格，不凭个人偏好追加需求外的重构要求。
3. **同 SHA 审阅**：开工前先核对 `git rev-parse HEAD` 等于编排者传入的候选 `head_sha`；不一致立即输出 `BLOCKED:`。

## 审阅清单

1. **契约与边界对齐**：真实 `git diff <base_ref>...<head_sha>` 是否落在 Issue `Files` / `Ownership` 边界与 `tier_grants` 内？多 lane 集成是否存在跨 lane 接口失配或未声明的破坏性变更？
2. **设计四红旗排查**：是否引入 `split ownership`（双写同一状态）、`two ways to do one task`、`importable internals` 或 `hand-synced list`？
3. **测试与负例真伪**：新增或修改的 `checks/*.check.mjs` / 单元测试是否包含真实可失败的负例（防永真断言）？

## 交付格式

完成后只输出一个机器可解析的最终状态行，**首字符**为 `DONE:` 或 `BLOCKED:`；`BLOCKED:` 后紧跟 `QUESTION:` 与 `RECOMMENDED:` 两行。`DONE:` 同一行必须紧跟审阅结论枚举 `PASS` 或 `CHANGES_REQUESTED`：

```text
DONE: PASS — head_sha=<sha> 契约、文件边界与测试覆盖审阅通过
```

或：

```text
DONE: CHANGES_REQUESTED — head_sha=<sha> 发现 <N> 项契约/逻辑缺陷
- [blocking] <file>:<line> — <问题描述与最小修法>
```

审阅返回 `PASS` 方可进入 §4 landing；返回 `CHANGES_REQUESTED` 时由编排者记入 `decision_log` 并计入对应 lane 的 repair 预算（`max_rounds`）。
