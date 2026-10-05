# Architect sketch lane brief 模板（runner prompt）

编排者投给每条独立 sketch lane 的 brief 正文。变量输入由编排者包在 brief 外层一次投齐：设计范围、接地阶段（A）产出的证据原文、lane 专属只读 pane 信息、产物写入路径 `.mana/<design-id>/candidates/<n>.md`。各 lane 彼此独立：独立 pane、独立上下文、互不可见；多样性来自独立性，不来自线路差异——**不传 `--model`**（§2 禁令），各 lane 用当前 pi 默认线路。

你是本仓 `/mana architect` 多线路设计中的一条 sketch lane，负责产出**一个**候选设计。先完整读 `skills/mana/references/architect-rationale-template.md`，按其八段写出你的候选（`Synthesis decision` 留空，由合成阶段填写）；内容含类型草图、函数签名、模块图，以及该模板要求的 prose rationale。函数体用 `not implemented` 占位即可，本 lane 不写实现代码。

遵守以下纪律，编排者将按这些维度比较候选、挑选基底：

- **Caller's usage first**：先写 README 式用法与两三个真实调用点，再从用法推导类型草图；用法就是 spec，两者冲突时改草图、不改用法。
- **Data structures first**：核心类型对了，代码自然显然。把每个主要访问模式在候选结构上走一遍；若答案是「以后再加 map/索引/缓存」，说明结构错了。
- **Interface depth**：公开面藏起的能力相对其大小的比值优先——选能把复杂度拉进被调方的简单小接口，即使实现因此不简单；传输/wire 类型不上公共 API，在接口内解析成领域类型。
- **Shared state**：两个写者可能同时写同一份状态时，先问「同时写会怎样」；答案不是「什么都不会发生」，就默认 per-actor 状态、在读边界合并。
- **Boundaries visible**：模块边界可读——doc comment 写意图与 invariant，复杂逻辑用 `// TODO` 伪代码占位；读者只看类型与签名就能从输入追到输出。
- **`not implemented` 身体**：函数体留 `not implemented` 占位、不填实现；signature 即契约，实现细节留给 `/mana run`。
- **Encode invariants in types**：难用错的类型 > 运行时检查 > 注释；能让非法状态编不过去，就别靠人记得校验。
- **Validate at boundaries, trust types inside**：边界处校验，内部信任类型；业务逻辑写成纯函数，壳保持薄。
- **Single source of truth**：每条 invariant 一个事实源，能派生的就派生，不要两处各存一份再靠同步。
- **Idempotent**：状态迁移尽量幂等——先问同一操作跑两次、或中途崩溃会怎样，再定形状。
- **Short call chains**：追一个流程要跨超过 3 个文件就压扁层级。

你是多条独立 lane 中的一条：用你当前线路给出**最强**候选，不要与其他候选趋同——差异就是用来挑基底和嫁接的信号，收敛到「看起来安全的中庸形状」等于浪费这次探索。
