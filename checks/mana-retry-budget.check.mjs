#!/usr/bin/env node
// 重试与预算契约自检（Issue #25）
// 无参数：断言 skills/mana/SKILL.md 含 lanes 三字段（max_wall_minutes/max_rounds/retry_mode）、
//         run 级 max_parallel_lanes、默认值 30/2/2、retry_mode 四枚举、
//         「tool-error 不自动换线」语义句、「墙钟超时先取证」语义句、
//         max_rounds 与 §2「最多 2 轮」为同一数、max_parallel_lanes 只计 running 的 code lane。
// --self-test：合成 drill——四类 retry_mode 判定（原样重投不计数/缩边界记 decision_log/
//         记 blocker 不换线/直接置终态）、max_parallel_lanes=1 时第二条 code lane 不入 running
//         而 readonly lane 不受影响、墙钟超时分类结果必为「先取证」。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const MODES = ["network", "context-overflow", "tool-error", "none"];

function assertSkillContract() {
  const skill = readFileSync(new URL("../skills/mana/SKILL.md", import.meta.url), "utf8");

  // 1) 四字段齐全：三个 lane 字段在 lanes schema 行，max_parallel_lanes 在 state 顶层 schema
  const schemaLine = skill.split("\n").find((l) => l.includes("lanes: [{"));
  assert.ok(schemaLine, "找到 §1 run 第 3 步 lanes 表 schema 行");
  for (const f of ["max_wall_minutes", "max_rounds", "retry_mode"])
    assert.ok(schemaLine.includes(f), `lanes schema 行含 ${f}`);
  assert.ok(schemaLine.includes("max_parallel_lanes"), "state 顶层 schema 含 max_parallel_lanes");

  // 2) 默认值 30/2/2
  assert.ok(skill.includes("`max_wall_minutes`（默认 30，lane 首次 dispatch 时写入）"), "max_wall_minutes 默认 30（dispatch 时写入）");
  assert.ok(skill.includes("`max_rounds`（默认 2）＝§2/§3「同一 lane 最多 2 轮」的那个数"), "max_rounds 默认 2 且就是既有「最多 2 轮」");
  assert.ok(skill.includes("`max_parallel_lanes`（默认 2）"), "max_parallel_lanes 默认 2");

  // 3) retry_mode 四枚举齐全
  for (const m of MODES) assert.ok(skill.includes(`\`${m}\``), `retry_mode 枚举缺 \`${m}\``);
  assert.ok(skill.includes("`retry_mode` ∈ {`network`,`context-overflow`,`tool-error`,`none`}"), "retry_mode 四枚举齐全");

  // 4) tool-error 不换线语义句（CTO 决策）
  assert.ok(skill.includes("**不自动换线**"), "tool-error 不自动换线（加粗语义句）");
  assert.ok(skill.includes("工人只用 pi 默认线路"), "换线禁令的依据写明（工人只用 pi 默认线路）");

  // 5) 墙钟超时先取证句
  assert.ok(skill.includes("墙钟超时不等于失败"), "含「墙钟超时不等于失败」标题句");
  assert.ok(skill.includes("必须先 `herdr agent get`/`read` 取证"), "超时后先取证再裁决");
  assert.ok(skill.includes("取证仍无定论才置 `blocked`"), "取证无定论才置 blocked");

  // 6) max_rounds 与 §2「2 轮」一致：§2 同句含「最多 2 轮」与 max_rounds
  const s2 = skill.split("## §2")[1]?.split("## §3")[0] ?? "";
  assert.ok(s2.includes("最多 2 轮"), "§2 保留「最多 2 轮」表述");
  assert.ok(s2.includes("max_rounds"), "§2 同句引用 max_rounds 字段（同一数的两个视角）");
  const s3 = skill.split("## §3")[1] ?? "";
  assert.ok(s3.includes("max_rounds") && s3.includes("max_wall_minutes"), "§3 监督循环衔接两字段（不重复表述）");

  // 7) max_parallel_lanes 只计 code lane 语义句
  assert.ok(skill.includes("只约束**同时处于 `running` 的 code lane 数**"), "只计 running 的 code lane");
  assert.ok(skill.includes("readonly lane 不计入"), "readonly lane 不计入");
  assert.ok(skill.includes("保持 `planned`"), "超限时新 lane 保持 planned");

  // 8) README 同步
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  for (const k of ["max_wall_minutes", "max_rounds", "retry_mode", "max_parallel_lanes"])
    assert.ok(readme.includes(k), `README 含 ${k}`);

  console.log("✓ SKILL.md/README.md 重试与预算契约断言通过（三字段+并发上限/默认值/四枚举/不换线/超时先取证/2轮同数）");
}

function selfTest() {
  // 按 SKILL.md 重试分类表合成判定函数（与表逐列对应）
  const retry = (lane) => {
    switch (lane.retry_mode) {
      case "network":
        return { action: "redispatch-same-brief", rounds: false, wall: true, log: ["decision_log"] };
      case "context-overflow":
        return { action: "evidence-then-shrink-boundary", rounds: true, wall: true, log: ["decision_log"] };
      case "tool-error":
        return { action: "record-blocker", rounds: false, wall: false, log: ["state.blocker", "decision_log"], switchRoute: false };
      case "none":
      default:
        return { action: "terminal", log: ["decision_log"] };
    }
  };

  // drill 1：四类 lane 各得表中动作
  const [a, b, c, d] = [
    { id: "lane-network", retry_mode: "network" },
    { id: "lane-overflow", retry_mode: "context-overflow" },
    { id: "lane-toolerr", retry_mode: "tool-error" },
    { id: "lane-none", retry_mode: "none" },
  ].map(retry);
  assert.equal(a.action, "redispatch-same-brief", "network 原样重投同一 lane 同一 brief");
  assert.equal(a.rounds, false, "network 不消耗 max_rounds");
  assert.equal(a.wall, true, "network 消耗墙钟");
  assert.deepEqual(a.log, ["decision_log"], "network 记 decision_log");

  assert.equal(b.action, "evidence-then-shrink-boundary", "context-overflow 先取证再缩小文件边界重投");
  assert.equal(b.rounds, true, "context-overflow 消耗 max_rounds");
  assert.ok(b.log.includes("decision_log"), "context-overflow 记 decision_log");

  assert.equal(c.action, "record-blocker", "tool-error 记 state.blocker");
  assert.equal(c.switchRoute, false, "tool-error 不自动换线（CTO 决策）");
  assert.ok(c.log.includes("state.blocker"), "tool-error 记 blocker + 原文");

  assert.equal(d.action, "terminal", "none 不重试直接置终态");

  // drill 2：max_parallel_lanes=1 时第二条 code lane 不得进入 running，readonly lane 不受影响
  const canDispatch = (state, lane) => {
    if (lane.kind !== "code") return true; // readonly lane 不计入
    const runningCode = state.lanes.filter((l) => l.kind === "code" && l.status === "running").length;
    return runningCode < state.max_parallel_lanes;
  };
  const state = { max_parallel_lanes: 1, lanes: [{ id: "l1", kind: "code", status: "running" }] };
  assert.equal(canDispatch(state, { id: "l2", kind: "code", status: "planned" }), false, "第二条 code lane 保持 planned");
  assert.equal(canDispatch(state, { id: "ro", kind: "readonly", status: "planned" }), true, "readonly lane 不计入、可派发");
  state.lanes[0].status = "verified"; // code lane 离开 running
  assert.equal(canDispatch(state, { id: "l2", kind: "code", status: "planned" }), true, "有 code lane 离开 running 后新 lane 可派发");

  // drill 3：墙钟超时不等于直接失败——分类结果必为「先取证」
  const onOverrun = (lane) => (lane.elapsed_min > lane.max_wall_minutes ? "collect-evidence-then-adjudicate" : "running");
  assert.equal(onOverrun({ max_wall_minutes: 30, elapsed_min: 31 }), "collect-evidence-then-adjudicate", "超 max_wall_minutes → 先取证");
  assert.equal(onOverrun({ max_wall_minutes: 30, elapsed_min: 999 }), "collect-evidence-then-adjudicate", "超时再久也先取证，不直接置失败");
  assert.notEqual(onOverrun({ max_wall_minutes: 30, elapsed_min: 999 }), "failed", "墙钟超时不得直接判失败");

  console.log("✓ 合成 drill 通过：四类 retry_mode 判定 + max_parallel_lanes=1 并发门 + 墙钟超时先取证");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  assertSkillContract();
}
