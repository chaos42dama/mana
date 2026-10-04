#!/usr/bin/env node
// 技能漂移检查契约自检（Issue #27）
// 无参数：断言 skills/mana/SKILL.md §3 三读含 origin/main 重读命令、§run 步骤 2
//         把 goal runtime 降级为便利层（state.json + 心跳为权威）、drift_checked_at 记账语义。
// --self-test：合成 drill——按 SKILL.md 规则判定「主干版 hash 与在用版不一致 →
//         记 drift（含两版 hash），且不得静默沿用旧版」（含一致/不一致正负例）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

function assertSkillContract() {
  const skill = readFileSync(new URL("../skills/mana/SKILL.md", import.meta.url), "utf8");

  // 1) §3 三读：从 origin/main 重读技能正本的确切命令
  assert.ok(skill.includes("origin/main:skills/mana/SKILL.md"), "§3 含从 origin/main 重读技能正本的命令");
  assert.ok(skill.includes("git hash-object --stdin"), "§3 含主干版 hash 取法（git hash-object --stdin）");
  const s3 = skill.split("## §3")[1] ?? "";
  assert.ok(s3.includes("三读"), "§3 sweep 第一步是三读");
  assert.ok(s3.includes("不得静默沿用旧版"), "漂移时不得静默沿用旧版");
  assert.ok(s3.includes("按主干版继续"), "漂移后按主干版继续执行");

  // 2) §run 步骤 2：goal runtime 降级为便利层，同段含 state.json 权威语义
  const runStep2 = skill.split("### run（已批准 Issue）")[1]?.split("## §2")[0] ?? "";
  const goalLine = runStep2.split("\n").find((l) => l.includes("便利层"));
  assert.ok(goalLine, "§run 步骤 2 含「便利层」");
  assert.ok(goalLine.includes("state.json"), "同段含 state.json（权威续航）");
  assert.ok(goalLine.includes("mana-heartbeat.sh"), "同段含心跳脚本（权威续航）");
  assert.ok(goalLine.includes("不构成 run 中断"), "goal runtime 丢失/失效/未暴露不构成 run 中断");

  // 3) drift 记账：drift_checked_at + 是否命中漂移
  assert.ok(s3.includes("drift_checked_at"), "§3 含 drift_checked_at 记账");
  assert.ok(s3.includes("UTC ISO"), "drift_checked_at 用 UTC ISO");
  assert.ok(s3.includes("drift: true") && s3.includes("drift: false"), "命中与否都写回 state");
  assert.ok(s3.includes("drift_versions"), "漂移命中写明两版 hash");
  const s5 = skill.split("## §5")[1] ?? "";
  assert.ok(skill.includes("在 §5 报告里列出"), "漂移命中在 §5 报告里列出");

  // 4) README 同步
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes("三读") && readme.includes("drift_checked_at"), "README 监督循环段同步三读/drift");
  assert.ok(readme.includes("便利层") && readme.includes("mana-heartbeat.sh"), "README 同步 goal 便利层语义");
  assert.ok(readme.includes("drift"), "README 英文段同步 drift 语义");

  console.log("✓ SKILL.md/README.md 漂移检查契约断言通过（三读/便利层/drift_checked_at）");
}

function selfTest() {
  // 合成 state（含 drift_checked_at），按 SKILL.md 规则判定：
  // used_hash != main_hash → 记 drift: true + 两版 hash，按主干版继续；不得静默沿用旧版。
  const recordDrift = (state, usedHash, mainHash) => {
    const next = {
      ...state,
      drift_checked_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      drift: usedHash !== mainHash,
    };
    if (next.drift) next.drift_versions = { used: usedHash, main: mainHash };
    return next;
  };

  const mainHash = execFileSync("git", ["hash-object", "--stdin"], { input: "skill@main\n" }).toString().trim();
  const usedHash = execFileSync("git", ["hash-object", "--stdin"], { input: "skill@used\n" }).toString().trim();
  const state = { run_id: "drill-27" };

  // 正例：两版不一致 → drift 命中，两版 hash 都记下
  const drifted = recordDrift(state, usedHash, mainHash);
  assert.equal(drifted.drift, true, "hash 不一致 → drift 命中");
  assert.ok(drifted.drift_checked_at, "drift_checked_at 已写回（UTC ISO）");
  assert.ok(/T.*Z$/.test(drifted.drift_checked_at), "drift_checked_at 为 UTC ISO 格式");
  assert.equal(drifted.drift_versions.used, usedHash, "记录在用版 hash");
  assert.equal(drifted.drift_versions.main, mainHash, "记录主干版 hash");
  assert.ok(drifted.drift_versions.used !== drifted.drift_versions.main, "非静默沿用：两版 hash 同时可见");

  // 负例：一致 → no_drift，不产生 drift_versions
  const clean = recordDrift(state, mainHash, mainHash);
  assert.equal(clean.drift, false, "hash 一致 → no_drift");
  assert.equal(clean.drift_versions, undefined, "未命中不写 drift_versions");

  console.log("✓ 合成 drill 通过：主干/在用 hash 不一致 → 记 drift（两版 hash）且不静默沿用；一致 → no_drift");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  assertSkillContract();
}
