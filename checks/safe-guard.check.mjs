// 临时校验：safe-guard 的自主模式开关（不进入仓库）
import assert from "node:assert/strict";
import ext, { DANGEROUS_PATTERNS } from "../extensions/safe-guard.ts";

const handlers = [];
ext({ on: (_name, handler) => handlers.push(handler) });
const hook = handlers[0];

function fakeCtx() {
  const calls = { confirm: 0, notify: 0 };
  return {
    calls,
    hasUI: true,
    ui: {
      confirm: async () => {
        calls.confirm++;
        return true;
      },
      notify: () => {
        calls.notify++;
      },
    },
  };
}

const rmEvent = { toolName: "bash", input: { command: "rm -rf /tmp/x" } };
const envEvent = { toolName: "write", input: { path: "/opt/src/your-repo/.env" } };

// 1) 默认（交互 UI）：危险命令必须确认，且不通知
delete process.env.MANA_AUTONOMOUS;
delete process.env.OMP_SAFE_GUARD;
let ctx = fakeCtx();
assert.equal(await hook(rmEvent, ctx), undefined, "default rm 不应阻断");
assert.equal(ctx.calls.confirm, 1, "default rm 必须确认一次");
assert.equal(ctx.calls.notify, 0, "default rm 不应通知");

// 2) 自主模式：放行 + 审计通知
process.env.MANA_AUTONOMOUS = "1";
ctx = fakeCtx();
assert.equal(await hook(rmEvent, ctx), undefined, "autonomous rm 不应阻断");
assert.equal(ctx.calls.confirm, 0, "autonomous rm 不应弹确认");
assert.equal(ctx.calls.notify, 1, "autonomous rm 应发审计通知");

// 3) 自主模式不放开受保护路径
ctx = fakeCtx();
await hook(envEvent, ctx);
assert.equal(ctx.calls.confirm, 1, "自主模式下受保护路径仍需确认");

// 4) OMP_SAFE_GUARD=off 同样生效；无 UI 时受保护路径硬阻断
process.env.OMP_SAFE_GUARD = "off";
ctx = fakeCtx();
await hook(rmEvent, ctx);
assert.equal(ctx.calls.confirm, 0, "OMP_SAFE_GUARD=off 应跳过危险命令确认");
ctx = fakeCtx();
await hook(envEvent, ctx);
assert.equal(ctx.calls.confirm, 1, "受保护路径在 OMP_SAFE_GUARD=off 下仍确认");
ctx.hasUI = false;
assert.equal((await hook(envEvent, ctx))?.block, true, "无 UI 时受保护路径必须硬阻断");

// 5) 模式匹配回归
assert.ok(DANGEROUS_PATTERNS.some((p) => p.test("rm -rf build")), "rm -rf 必须命中");
assert.ok(
  !DANGEROUS_PATTERNS.some((p) => p.test("git checkout HEAD -- apps/web/App.tsx")),
  "git checkout 不在危险模式内（#1602 引用的弹窗来自更早的 pattern 集）",
);

console.log("✓ safe-guard 自主模式校验通过（5 组断言）");
