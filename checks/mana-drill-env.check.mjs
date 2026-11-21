#!/usr/bin/env node
// Issue #117：契约 check 的宿主环境隔离 drill（常驻，`--self-test`）。
//
// 三条真实事故（同一 check 在不同宿主上给出不同结论）：
//   D1 宿主 MANA_SRC=/tmp → 预检源解析门判缺 extensions/ → 假红
//   D3 宿主 MANA_* 全量透传子 check → 结论随宿主漂移；但递归守卫 MANA_SELFTEST_ACTIVE 必须继续传，
//      剥掉它会让 preflight→selftest→all.check→line-check→preflight 无限递归
//   D4 宿主 MANA_PREFLIGHT_SKIP_SMOKE=1 → 线路门机读行变 state=skipped → 假绿
//
// 断言（无参 = 契约静态断言；--self-test = 真进程 drill，额外含负例）：
//   1. all.check.mjs 用白名单子环境，不透传 MANA_*/PI_*/HERDR_*
//   2. 白名单显式透传 MANA_SELFTEST_ACTIVE（唯一例外，防递归环）
//   3. 两个 preflight 调用方都剥离 MANA_SRC / MANA_PREFLIGHT_SKIP_SMOKE
//   4. selftest 嵌套 + --force-contracts 真非 0（不许静默 SKIP 报 0）
//   5. 负例：真进程断言 D1/D4 注入下两 check 仍 rc=0（剥离失效则必红）
//
// 与 pig-gate 同规矩：暂存目录落 tmpdir() 按进程隔离，绝不写仓库工作树。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SELF_TEST = process.argv.includes("--self-test");
const read = (p) => readFileSync(join(REPO, p), "utf8");

// ── 契约静态断言（两种模式都跑） ──────────────────────────────────────────
{
  const all = read("checks/all.check.mjs");
  // 1. 白名单存在且确实用于 spawnSync
  assert.ok(all.includes("ENV_ALLOW"), "all.check 应有 ENV_ALLOW 白名单");
  assert.match(all, /env:\s*childEnv/, "spawnSync 必须传 env: childEnv");
  assert.ok(
    !/ENV_ALLOW\s*=\s*new Set\(\[[^\]]*"MANA_/.test(all),
    "白名单不得整体放行 MANA_*（只允许下面单点透传）",
  );
  // 2. 递归守卫单点透传
  assert.ok(
    all.includes('"MANA_SELFTEST_ACTIVE" in process.env'),
    "all.check 必须显式透传 MANA_SELFTEST_ACTIVE（否则递归环切断失效）",
  );
  assert.ok(
    !all.includes("MANA_PREFLIGHT_SKIP_SMOKE\" in process.env"),
    "MANA_PREFLIGHT_SKIP_SMOKE 不得透传（是宿主污染面）",
  );
  console.log("✓ 组1 all.check 白名单 + 仅透传 ACTIVE");
}

// 两文件对 MANA_SRC 的做法不同（pig-gate 先剥离再显式设；line-check 用展开后覆盖），
// 效果同为「合成 env 只认本仓」，故分文件断言具体形态。
const PREFLIGHT_CALLERS = [
  {
    file: "checks/preflight-pig-gate.check.mjs",
    srcStrip: /MANA_SRC:\s*_leakSrc/,
    repoStrip: /MANA_REPO:\s*_leakRepo/,
    runStrip: /MANA_RUN_ID:\s*_leakRun/,
  },
  {
    file: "checks/mana-preflight-line.check.mjs",
    srcStrip: /MANA_SRC:\s*REPO/,
    repoStrip: /MANA_REPO:\s*_leakRepo/,
    runStrip: /MANA_RUN_ID:\s*_leakRun/,
  },
];
for (const { file: f, srcStrip, repoStrip, runStrip } of PREFLIGHT_CALLERS) {
  const src = read(f);
  assert.match(src, srcStrip, `${f} 必须让合成 env 的 MANA_SRC 只指本仓（D1）`);
  assert.match(src, repoStrip, `${f} 必须剥离 MANA_REPO`);
  assert.match(src, runStrip, `${f} 必须剥离 MANA_RUN_ID`);
}
console.log("✓ 组2 两个 preflight 调用方剥离 MANA_SRC/REPO/RUN_ID");

{
  const line = read("checks/mana-preflight-line.check.mjs");
  assert.ok(
    line.includes("MANA_PREFLIGHT_SKIP_SMOKE: _leakSkipSmoke"),
    "line-check 必须剥离宿主 MANA_PREFLIGHT_SKIP_SMOKE（D4）",
  );
  const pf = read("checks/preflight-pig-gate.check.mjs");
  assert.ok(pf.includes("MANA_PREFLIGHT_SKIP_SMOKE"), "pig-gate 必须自设 SKIP_SMOKE（只验门逻辑）");
  console.log("✓ 组3 SKIP_SMOKE 剥离 + pig-gate 自设");
}

{
  const st = read("scripts/mana-selftest.sh");
  assert.match(
    st,
    /\[\s*"\$FORCE"\s*=\s*"1"\s*\]/,
    "selftest 嵌套 SKIP 分支必须有 FORCE=1 判定（D2）",
  );
  assert.ok(st.includes("✗ contracts"), "嵌套 + force 必须输出 ✗ contracts 且判 FAILED");
  assert.ok(!st.includes("NESTED_OK"), "NESTED_OK 方案已废弃，不得残留");
  const pf = read("scripts/mana-preflight.sh");
  assert.ok(pf.includes("SELFTEST_FORCE"), "preflight 必须按上下文决定是否传 --force-contracts");
  assert.match(
    pf,
    /MANA_SELFTEST_ACTIVE:-\}.*\|\|.*MANA_PREFLIGHT_SKIP_SMOKE/s,
    "preflight 的 force 判定必须同时看 ACTIVE 与 SKIP_SMOKE",
  );
  console.log("✓ 组4 selftest force 冲突失败 + preflight 上下文定 force");
}

// ── 真进程 drill（仅 --self-test） ───────────────────────────────────────
if (SELF_TEST) {
  const run = (cmd, args, env) =>
    spawnSync(cmd, args, {
      cwd: REPO,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, ...env },
    });

  // 5. D2：嵌套 + force 必须非 0。修复前是 SKIP 后 0（假绿）。
  {
    const r = run("bash", ["scripts/mana-selftest.sh", "--quick", "--force-contracts"], {
      MANA_SELFTEST_ACTIVE: "1",
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.notEqual(r.status, 0, `嵌套 + force 必须非 0（修复前假绿）\n${out}`);
    assert.ok(out.includes("✗ contracts"), `必须点名 ✗ contracts\n${out}`);
    console.log("✓ 组5 nested + --force-contracts → 非 0");
  }

  // 6. 对照：嵌套无 force 仍 SKIP + rc=0（既有行为不得破坏）
  {
    const r = run("bash", ["scripts/mana-selftest.sh", "--quick"], {
      MANA_SELFTEST_ACTIVE: "1",
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, `嵌套无 force 必须仍 rc=0\n${out}`);
    assert.ok(out.includes("SKIP contracts"), `必须仍 SKIP contracts\n${out}`);
    assert.ok(out.includes("ALL-5-rc=0"), `必须 ALL-5-rc=0\n${out}`);
    console.log("✓ 组6 nested 无 force → SKIP contracts + rc=0（对照未破）");
  }

  // 7. D1/D4 负例：注入宿主污染，预检调用方仍 rc=0；剥离失效则必红。
  //    只跑 pig-gate 一条：断裂点都是 runPreflight 的 env 构造，两文件同构；
  //    两文件的剥离代码形态已由组 2/3 静态断言。两条都跑会在 all.check 的 60s 单项超时下超时。
  {
    const env = { MANA_SRC: "/tmp", MANA_PREFLIGHT_SKIP_SMOKE: "1", MANA_SELFTEST_ACTIVE: "1" };
    const f = "checks/preflight-pig-gate.check.mjs";
    const r = run(process.execPath, [f], env);
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, `${f} 在 MANA_SRC=/tmp + SKIP_SMOKE=1 下必须仍 rc=0（剥离失效）\n${out}`);
    console.log("✓ 组7 宿主污染注入（MANA_SRC=/tmp + SKIP_SMOKE=1）→ pig-gate 仍 rc=0");
  }
}

console.log(
  SELF_TEST
    ? "✓ mana drill env 契约（静态 + 真进程 drill）通过"
    : "✓ mana drill env 契约（静态）通过；--self-test 跑真进程 drill",
);
