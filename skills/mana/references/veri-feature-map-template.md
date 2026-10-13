# veri feature map template

Source: cursor/plugins pstack /create-verification-skill (MIT, Copyright 2026 Lauren Tan)

## features/README.md 索引模板

```markdown
---
app: <app-name>
features:
  - <feature-slug-1>
  - <feature-slug-2>
---

# <app> verification features

| feature | last_verified_sha | last_verified_at | verdict |
| --- | --- | --- | --- |
| <feature-slug-1> | <sha 或空> | <UTC ISO 或空> | <verdict 或 unverified> |
```

## 每 feature 文件模板（`features/<slug>.md`）

```markdown
---
last_verified_sha: <验证通过时的 HEAD sha；未验证留空>
last_verified_at: <UTC ISO，如 2026-01-01T00:00:00Z；未验证留空>
# verdict 取值：live | unit | type-only | blocked | failed | verified-unreachable
#   live = 真实环境端到端跑通；unit = 单测级证据；type-only = 仅类型/静态检查；
#   blocked = 前置缺失跑不了；failed = 跑了但失败；verified-unreachable = 环境不可达但已人工核验
verdict: <上列之一>
prerequisites:
  - <该 feature 验证前的依赖，如「本地 DB 已起」「需要 X 环境变量」>
---

## Sub-features

- <该 feature 拆出的可独立验证子项>

## How to get to it (user POV)

- <用户从界面/CLI 如何走到这个 feature>

## Driving it with <harness>

```bash
<可直接复制的驱动命令>
```

## Gotchas

- <易错点、隔离要求、已知副作用>
```

## 陈旧度判定（status 口径）

- `last_verified_sha` 落后 `origin/main`，或 `last_verified_at` 距今超过约定天数 → 判陈旧。
- 陈旧 feature 的处置属 maintain（Scan，/mana veri maintain 口，Issue #80）：扫描结果 `clean|changed|blocked`；`changed` 时转 intake、经 `/mana run` 出 ≤1 PR。本模板只定义判定，不定义修复流程。
