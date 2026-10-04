#!/usr/bin/env node
// 工人交付洁净契约自检（Issue #45）
// 无参数：断言 skills/mana/SKILL.md §2 工人交付条含交付洁净契约、§2 brief 收尾条件列出交付洁净契约、
//         §3 绑 SHA 前先查工作树（脏则不绑 head_sha、不判 verified）、§1 intake 第 3 步已无
//         goal runtime 旧句且与 §1 run 第 2 步同口径、README.md 中英同步。
// --self-test：合成 drill——(a) DONE + 脏树但仅格式化 → 要求/执行 commit 后再绑 SHA 重验；
//         (b) DONE + 脏树且含语义改动 → 不得静默丢弃，须打回让工人 commit 或编排者明确丢弃
//         并记 decision_log，处置后才可判 verified（含洁净树正例与脏树负例）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function assertSkillContract() {
  const skill = readFileSync(new URL("../skills/mana/SKILL.md", import.meta.url), "utf8");
  const s2 = skill.split("## §2")[1]?.split("## §3")[0] ?? "";
  const s3 = skill.split("## §3")[1]?.split("## §4")[0] ?? "";

  // 1) §2 工人交付条：交付洁净契约
  assert.ok(s2.includes("交付洁净契约"), "§2 工人交付条含交付洁净契约");
  assert.ok(s2.includes("工作区必须洁净"), "§2 洁净契约：DONE 前工作区必须洁净");
  assert.ok(s2.includes("`git status --short` 输出为空"), "§2 洁净契约判定命令：git status --short 输出为空");
  assert.ok(s2.includes("一并 commit"), "纯格式化/工具自动改写必须与成果一并 commit");
  assert.ok(s2.includes("保持工作区干净"), "点名不得以「保持工作区干净」为名丢弃语义改动");

  // 2) §2 brief 三段式：收尾条件列出交付洁净契约
  const briefLine = s2.split("\n").find((l) => l.includes("三段式"));
  assert.ok(briefLine, "找到 §2 brief 三段式行");
  assert.ok(briefLine.includes("交付洁净契约"), "brief 收尾条件列出交付洁净契约");

  // 3) §3 监督循环第 2 步：绑 SHA 前先查工作树
  const doneLine = s3.split("\n").find((l) => l.includes("`DONE` 是 claim"));
  assert.ok(doneLine, "找到 §3 第 2 步（DONE 是 claim）");
  assert.ok(doneLine.includes("`git status --short`"), "绑 SHA 前先查工作树（git status --short）");
  assert.ok(doneLine.includes("不绑 `head_sha`") && doneLine.includes("不判 `verified`"), "脏树不绑 head_sha、不判 verified");
  assert.ok(doneLine.includes("失效规则"), "脏树按 §1 run 第 3 步失效规则处置");
  assert.ok(doneLine.includes("decision_log"), "编排者明确丢弃须记 decision_log");

  // 4) §1 intake 第 3 步：goal runtime 口径与 run 第 2 步一致
  assert.ok(!skill.includes("它用于维持已批准 run 的终态"), "intake 第 3 步旧句（它用于维持已批准 run 的终态）已删除");
  const intake = skill.split("### intake（目标尚未成为可执行 Issue）")[1]?.split("### context")[0] ?? "";
  const intakeStep3 = intake.split("\n").find((l) => l.trim().startsWith("3."));
  assert.ok(intakeStep3, "找到 intake 第 3 步");
  assert.ok(intakeStep3.includes("便利层"), "intake 第 3 步：goal runtime 只是便利层（与 run 第 2 步同口径）");
  assert.ok(intakeStep3.includes("不取代 intake 的需求澄清"), "intake 第 3 步仍声明不取代需求澄清");
  assert.ok(intakeStep3.includes("不得把 goal runtime 当作需求澄清或续航的依赖"), "intake 不得把 goal runtime 当作需求澄清或续航的依赖");
  const run = skill.split("### run（已批准 Issue）")[1]?.split("### resume")[0] ?? "";
  const runStep2 = run.split("\n").find((l) => l.includes("便利层"));
  assert.ok(runStep2?.includes("唯一权威续航"), "run 第 2 步权威续航口径仍在（state.json + 心跳）");

  // 5) README 中英同步
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const zh = readme.split("# Mana (English)")[0] ?? "";
  const en = readme.split("# Mana (English)")[1] ?? "";
  assert.ok(zh.includes("交付洁净契约") && zh.includes("`git status --short`"), "README 中文段同步交付洁净/洁净门");
  assert.ok(en.includes("clean") && en.includes("`git status --short`"), "README English 段同步 delivery hygiene");

  console.log("✓ SKILL.md/README.md 工人交付洁净契约断言通过（§2 洁净契约/brief 收尾/§3 脏树前置/goal runtime 口径/README）");
}

function selfTest() {
  // 按 SKILL.md §3 第 2 步合成编排者的洁净门判定：
  // DONE 是 claim；绑 head_sha 前先查工作树，脏则先处置再重跑 acceptance。
  const hygieneGate = (done, dirty, { formatOnly = false } = {}) => {
    assert.ok(done.startsWith("DONE:"), "仅处理 DONE claim（BLOCKED 走 needs_input）");
    if (!dirty) return { bindSha: false, verified: false, action: "重跑 acceptance，通过才绑 head_sha 判 verified" };
    // 脏树：不绑 head_sha、不判 verified，先处置
    if (formatOnly)
      return { bindSha: false, verified: false, action: "要求工人 commit（纯格式化与成果一并 commit）后再绑 SHA 重跑 acceptance" };
    return {
      bindSha: false,
      verified: false,
      action: "不得静默丢弃：打回让工人 commit，或编排者明确丢弃并记 decision_log，处置后才可判 verified",
    };
  };

  // 情形 (a)：DONE + 脏树但仅格式化 → 要求/执行 commit 后再绑 SHA
  const a = hygieneGate("DONE: 全部完成", true, { formatOnly: true });
  assert.equal(a.bindSha, false, "情形 (a) 脏树不绑 head_sha");
  assert.equal(a.verified, false, "情形 (a) 不判 verified");
  assert.match(a.action, /commit/, "情形 (a) 处置动作 = commit 后再绑 SHA");
  assert.match(a.action, /再绑 SHA/, "情形 (a) 处置完成后才绑 SHA 重验");

  // 情形 (b)：DONE + 脏树且含语义改动 → 不得静默丢弃，须打回或记 decision_log 后才可判 verified
  const b = hygieneGate("DONE: 全部完成", true, { formatOnly: false });
  assert.equal(b.bindSha, false, "情形 (b) 脏树不绑 head_sha");
  assert.equal(b.verified, false, "情形 (b) 不判 verified");
  assert.match(b.action, /不得静默丢弃/, "情形 (b) 语义改动不得静默丢弃");
  assert.match(b.action, /打回/, "情形 (b) 须打回让工人 commit 或说明");
  assert.match(b.action, /decision_log/, "情形 (b) 明确丢弃须记 decision_log");

  // 正例：洁净树才进入 acceptance 复验；负例：脏树上绑 SHA/判 verified 的越权动作被契约守卫拒绝
  const clean = hygieneGate("DONE: 全部完成", false);
  assert.match(clean.action, /重跑 acceptance/, "洁净树才进入 acceptance 复验");
  const contractGuard = (r) => {
    if (r.bindSha || r.verified) throw new Error("脏树上绑 head_sha/判 verified");
  };
  assert.doesNotThrow(() => {
    contractGuard(a);
    contractGuard(b);
  }, "洁净门下 a/b 都不绑 SHA 不判 verified");
  assert.throws(() => contractGuard({ bindSha: true, verified: false, action: "x" }), /脏树上绑 head_sha/, "脏树绑 head_sha 被拒");
  assert.throws(() => contractGuard({ bindSha: false, verified: true, action: "x" }), /脏树上绑 head_sha/, "脏树判 verified 被拒");

  console.log("✓ 合成 drill 通过：(a) 仅格式化脏树 → commit 后再绑 SHA；(b) 语义改动脏树 → 不得静默丢弃，处置后才可判 verified");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  assertSkillContract();
}
