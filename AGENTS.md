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

- scripts/mana-run-lock.py、scripts/check-mana-grant-scope.py、scripts/check-mana-issue.py（intake Issue 骨架校验）属 run 基础设施，改动须单独授权。
