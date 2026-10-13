# veri generator prompt — explorer lane brief 模板

Source: cursor/plugins pstack /create-verification-skill (MIT, Copyright 2026 Lauren Tan)

> orchestrator 按本模板拼 brief 投给只读 explorer lane（dispatch 同 §2：`herdr agent start <name> --kind pi --pane <pane-id>`，**不传 `--model`**）。

## goal
对目标应用做五步访谈并生成 `verify-<app>/` 验证技能；生成后 orchestrator 亲自端到端实跑，未被执行过的生成技只算 draft，不算交付。**永不改产品代码。**

## 五步访谈（Surface / Run / Drive / Observe / Isolate）
只问代码库不问用户；依据仓内 README、Makefile、package scripts 取证。

1. **Surface**：识别应用入口、模块清单、可验证的 feature 面（读 README、目录结构、路由/CLI/导出）。
2. **Run**：找启动/构建命令（README、Makefile、package scripts），记录每条命令的工作目录与前置条件。
3. **Drive**：确定用什么 harness 驱动每个 feature（CLI 参数、HTTP 调用、脚本、测试入口），给出可直接复制的命令。
4. **Observe**：确定每个 feature 的可观察证据（输出文本、退出码、日志文件、生成的 artifact、状态接口）。
5. **Isolate**：确定每个 feature 的隔离与清理方式（临时目录、环境变量、测试 DB、cleanup 命令），确保互不污染。

## 生成规约
产出写到 `.pi/skills/verify-<app>/`（工作区内；禁写 `~/.pi/**` 用户级目录）：

- `SKILL.md` 六节，无占位符（每节须可执行，不留 TODO/`<...>` 未填充）：
  **Launch / Doctor / Drive / Evidence / Cleanup / Helpers**
  - Launch：启动应用与前置条件；Doctor：环境自检（零副作用）；Drive：逐 feature 驱动命令；Evidence：证据落盘位置与格式；Cleanup：回收与隔离还原；Helpers：可复用脚本/函数清单。
- `features/README.md` 索引 + **3–5 个 feature 文件**（模板见 `veri-feature-map-template.md`），每个文件四 H2：
  `Sub-features` / `How to get to it (user POV)` / `Driving it with <harness>` / `Gotchas`；
  front-matter 接账本四键 `last_verified_sha` / `last_verified_at` / `verdict` / `prerequisites`。

## 端到端实跑要求
生成完成后 orchestrator 必须亲自：launch → doctor → drive 1 个 feature → 取证 → cleanup → 确认证据在 cleanup 后仍在。**未被执行过的生成技只算 draft，不算交付。**

## 证据目录
证据写在约定目录；**cleanup 后证据仍在**（清理的是应用状态，不是证据）。
