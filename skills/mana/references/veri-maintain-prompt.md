# veri maintain source wave prompt — per-feature 只读 lane brief 模板

Source: cursor/plugins pstack /maintain-verification-skill (MIT, Copyright 2026 Lauren Tan)

> orchestrator 按本模板拼 brief 投给每 feature 一条只读 lane（dispatch 同 §2，**不传 `--model`**；同时 running 的 lane 峰值 ≤ `max_parallel_lanes`）。本模板只管 lane brief，不写 dispatch 命令。

## goal
对 verify-<app> 的单个 feature 做只读对账：核对功能地图与当前源码是否一致。**不驱动应用、不改任何文件**。

## 每 feature 返回固定四要素
1. **feature 摘要**：该 feature 当前实际做什么（以源码为准，不是照抄地图）。
2. **源码入口点**：入口文件/符号/调用路径清单。
3. **可能 drift**：地图描述与源码不一致之处，每条附引用（`<源码路径>:<行>`）。
4. **一条 live 验证 recipe**：可直接复制复验该 feature 的命令（只给命令与预期观察，不执行）。

## 返回形态示例

```text
feature: <slug>
摘要: <一两句，以源码为准>
入口点:
- src/foo/bar.ts:42 (handler)
- src/foo/cli.ts:17 (CLI 子命令)
drift:
- 地图称支持 --json 输出，源码未见该 flag (src/foo/cli.ts:17-40)
recipe:
```bash
<命令>
# 预期: <可观察证据>
```
```

## 禁令
- **不驱动应用**：不启动服务、不执行 recipe、不跑测试。
- **不改任何文件**：verify-<app> 目录与产品代码都不碰；结论只在回复里给。
- **不传 `--model`**、不 push、不建 PR、不改 Issue。
- 拿不准的标推测，不写成事实。
