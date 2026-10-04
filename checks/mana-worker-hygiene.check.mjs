#!/usr/bin/env node
// 工人交付洁净契约自检（Issue #45；Issue #51 扩写为可审计三步）
// 无参数：断言 skills/mana/SKILL.md §2 工人交付条含交付洁净契约、§2 brief 收尾条件列出交付洁净契约、
//         §3 绑 SHA 前先查工作树（脏则不绑 head_sha、不判 verified）且脏树处置为可审计三步
//         （① 取证 git status --short + git diff 原文 → ② 归类 (a)/(b) → ③ 处置，取证缺失 ⇒ 不得处置）、
//         §1 决策轨迹落盘含截断口径（--stat 汇总行 + 代表性 hunk + 注明范围）、§5 Attention 段固定要求、
//         §1 intake 第 3 步已无 goal runtime 旧句且与 §1 run 第 2 步同口径、README.md 中英同步。
// --self-test：合成 drill——构造两份脏树 diff 文本（仅格式化 / 含语义），走契约分类函数断言归类与处置：
//         (a) 仅格式化 → commit 后绑 SHA；(a) + 工人已收尾 → 编排者代 commit 并记 decision_log；
//         (b) 含语义 → 打回、不绑 SHA、attempt 不推进 max_rounds 不消耗；(b) 仍要丢弃 → 必须先有 diff
//         原文证据 + Attention 条目，缺一即 assert.throws（负例必须真失败）。
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

  // 3) §3 监督循环第 2 步：绑 SHA 前先查工作树，脏树走可审计三步（取证 → 归类 → 处置）
  const doneLine = s3.split("\n").find((l) => l.includes("`DONE` 是 claim"));
  assert.ok(doneLine, "找到 §3 第 2 步（DONE 是 claim）");
  assert.ok(doneLine.includes("`git status --short`"), "绑 SHA 前先查工作树（git status --short）");
  assert.ok(doneLine.includes("不绑 `head_sha`") && doneLine.includes("不判 `verified`"), "脏树不绑 head_sha、不判 verified");
  assert.ok(doneLine.includes("取证缺失 ⇒ 不得处置") && doneLine.includes("不得绑 SHA"), "取证缺失 ⇒ 不得处置（不得 commit/discard/绑 SHA）");
  const afterDone = s3.slice(s3.indexOf(doneLine));
  const i1 = afterDone.indexOf("① 取证"), i2 = afterDone.indexOf("② 归类"), i3 = afterDone.indexOf("③ 处置");
  assert.ok(i1 > -1 && i2 > i1 && i3 > i2, "三步顺序语义：先取证（git status --short + git diff 原文）再归类后处置");
  assert.ok(afterDone.includes("`git diff --stat` 汇总行"), "① 取证含 git diff --stat 汇总行");
  assert.ok(afterDone.includes("原文**逐字"), "① 取证要求 diff 原文逐字留存");
  assert.ok(afterDone.includes("(a) 纯格式化") && afterDone.includes("(b) 含语义改动"), "② 归类：(a) 纯格式化 vs (b) 含语义改动");
  assert.ok(afterDone.includes("禁止静默丢弃"), "③ 处置 (b)：禁止静默丢弃");
  assert.ok(afterDone.includes("`attempt` 不推进") && afterDone.includes("`max_rounds` 不消耗"), "③ 处置 (b)：attempt 不推进、max_rounds 不消耗");
  assert.ok(afterDone.includes("编排者代 commit"), "③ 处置 (a)：工人已收尾时编排者代 commit 须标注");
  assert.ok(afterDone.includes("失效规则"), "脏树按 §1 run 第 3 步失效规则处置");
  assert.ok(afterDone.includes("decision_log"), "取证/归类/代 commit 都落 decision_log");

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

  // 4.5) §1 run 第 3 步决策轨迹落盘：脏树取证留档口径（截断不掩盖语义改动）
  const ledgerLine = run.split("\n").find((l) => l.includes("决策轨迹落盘"));
  assert.ok(ledgerLine, "找到 §1 决策轨迹落盘条");
  assert.ok(ledgerLine.includes("`git diff --stat` 汇总行"), "留档口径：必含 git diff --stat 汇总行");
  assert.ok(ledgerLine.includes("代表性 hunk"), "留档口径：必含至少一处代表性 hunk");
  assert.ok(ledgerLine.includes("注明范围") && ledgerLine.includes("不得以截断掩盖语义改动"), "截断须注明范围，不得以截断掩盖语义改动");

  // 4.6) §5 Attention 段：代 commit 与丢弃含语义改动必列
  const s5 = skill.split("## §5")[1]?.split("## OMP")[0] ?? "";
  const attnLine = s5.split("\n").find((l) => l.includes("`Attention` 段"));
  assert.ok(attnLine, "找到 §5 Attention 段");
  assert.ok(attnLine.includes("编排者代 commit"), "Attention 固定要求：编排者代 commit 必列一条");
  assert.ok(attnLine.includes("丢弃含语义改动的 diff"), "Attention 固定要求：丢弃含语义改动的 diff 必列一条");
  assert.ok(attnLine.includes("decisions.tsv"), "Attention 条目可从 decisions.tsv 的 evidence 引用");

  // 5) README 中英同步（交付洁净契约 + 脏树处置可审计）
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const zh = readme.split("# Mana (English)")[0] ?? "";
  const en = readme.split("# Mana (English)")[1] ?? "";
  assert.ok(zh.includes("交付洁净契约") && zh.includes("`git status --short`"), "README 中文段同步交付洁净/洁净门");
  assert.ok(en.includes("clean") && en.includes("`git status --short`"), "README English 段同步 delivery hygiene");
  const zh10 = zh.split("\n").find((l) => l.trim().startsWith("10."));
  assert.ok(zh10?.includes("脏树处置可审计"), "README 中文第 10 条：脏树处置可审计（编号接在第 9 条后）");
  assert.ok(zh10?.includes("`git diff`") && zh10?.includes("禁止静默丢弃") && zh10?.includes("`Attention`"), "README 中文第 10 条：取证/禁止静默丢弃/Attention 三要素");
  const en12 = en.split("\n").find((l) => l.trim().startsWith("12."));
  assert.ok(en12?.includes("auditable"), "README English 第 12 条：dirty-tree handling is auditable（编号接在 #11 后）");
  assert.ok(en12?.includes("`git diff`") && en12?.includes("Attention"), "README English 第 12 条：evidence/Attention 要素");

  console.log("✓ SKILL.md/README.md 工人交付洁净契约断言通过（§2 洁净契约/brief 收尾/§3 脏树三步处置/§1 留档口径/§5 Attention/goal runtime 口径/README）");
}

function selfTest() {
  // §3 第 2 步可审计三步的合成模型：取证 → 归类 → 处置。
  // 取证缺失 ⇒ 不得处置（throw）；(a) commit（工人或编排者代 commit）；(b) 打回不消耗轮次；
  // (b) 丢弃须 diff 原文证据 + Attention 条目。
  const auditableGate = ({ dirty, evidence, classification, workerAvailable }) => {
    if (!dirty)
      return { action: "clean", bindSha: false, verified: false, detail: "重跑 acceptance，通过才绑 head_sha 判 verified" };
    // ① 取证门：无 diff 原文证据 ⇒ 不得处置
    if (!evidence) throw new Error("取证缺失 ⇒ 不得处置（不得 commit、不得 discard、不得绑 SHA）");
    if (!evidence.includes("git diff --stat")) throw new Error("取证缺 `git diff --stat` 汇总行 ⇒ 不得处置");
    if (!evidence.includes("@@")) throw new Error("取证缺代表性 hunk ⇒ 不得处置");
    // ② 归类 → ③ 处置
    if (classification === "a") {
      if (workerAvailable)
        return { action: "commit", by: "worker", bindSha: false, verified: false, detail: "工人把纯格式化改动与成果一并 commit 后，重跑 acceptance 再绑 SHA" };
      return { action: "commit", by: "orchestrator", bindSha: false, verified: false, detail: "编排者代 commit，decision_log 标注「编排者代 commit」" };
    }
    return {
      action: "sendBack",
      by: "worker",
      bindSha: false,
      verified: false,
      attemptAdvances: false,
      consumesRounds: false,
      detail: "禁止静默丢弃：打回让工人 commit 或明确说明；洁净门整改不是 §2 重试，attempt 不推进、max_rounds 不消耗",
    };
  };
  // (b) 仍要丢弃：必须先有 diff 原文证据 + Attention 条目，缺一即抛
  const discardSemantic = ({ evidence, attentionEntry }) => {
    if (!evidence || !evidence.includes("git diff --stat") || !evidence.includes("@@"))
      throw new Error("取证缺失 ⇒ 不得处置：丢弃前必须先有 git status --short + git diff 原文证据");
    if (!attentionEntry) throw new Error("丢弃含语义改动的 diff ⇒ §5 Attention 段必须列出，缺一即不得丢弃");
    return { action: "discard", attemptAdvances: false, consumesRounds: false, attention: attentionEntry };
  };
  // ② 归类的最小合成实现：增删行含断言/逻辑/控制流关键词 → (b)，否则 (a) 纯格式化
  const classifyDiff = (diffText) => {
    const changed = diffText.split("\n").filter((l) => /^[+-]/.test(l) && !/^[+-]{3}/.test(l));
    const semanticRe = /(assert|throw|if |return |=>|function|expect|import |export )/i;
    return changed.some((l) => semanticRe.test(l.slice(1)))
      ? { kind: "b", label: "含语义改动" }
      : { kind: "a", label: "纯格式化/工具自动改写" };
  };

  // 两份脏树 diff 文本（live 合成 drill 输入）
  const diffFormatOnly = [
    "git diff --stat",
    " README.md | 6 +++---",
    "@@ -40,9 +40,9 @@",
    "-一段很长的说明文字被 pi-lens 重排成了多行，行宽变了但内容没变。",
    "+一段很长的说明文字被 pi-lens 重排成了多行，\n+行宽变了但内容没变。",
  ].join("\n");
  const diffSemantic = [
    "git diff --stat",
    " checks/x.check.mjs | 20 +++++---",
    "@@ -30,4 +30,8 @@",
    "-  assert.ok(done);",
    "+  assert.equal(done, false);",
    "+  if (dirty) return { blocked: true };",
  ].join("\n");

  // 归类断言：契约分类函数对两份 diff 给出 (a)/(b)
  assert.equal(classifyDiff(diffFormatOnly).kind, "a", "仅格式化 diff 归类为 (a)");
  assert.equal(classifyDiff(diffSemantic).kind, "b", "含断言/逻辑增删的 diff 归类为 (b)");

  // 情形 1：(a) 仅格式化、工人在场 → 工人 commit 后再绑 SHA
  const a1 = auditableGate({ dirty: true, evidence: diffFormatOnly, classification: classifyDiff(diffFormatOnly).kind, workerAvailable: true });
  assert.equal(a1.action, "commit", "情形 1：(a) 处置 = commit");
  assert.equal(a1.by, "worker", "情形 1：优先工人自己 commit");
  assert.equal(a1.bindSha, false, "情形 1：commit 完成前不绑 SHA");
  assert.match(a1.detail, /再绑 SHA/, "情形 1：commit 后重验再绑 SHA");
  const a1done = auditableGate({ dirty: false });
  assert.match(a1done.detail, /重跑 acceptance/, "情形 1 收尾：洁净树重跑 acceptance 通过才判 verified");

  // 情形 2：(a) 仅格式化、工人已收尾 → 编排者代 commit 并记 decision_log
  const a2 = auditableGate({ dirty: true, evidence: diffFormatOnly, classification: "a", workerAvailable: false });
  assert.equal(a2.by, "orchestrator", "情形 2：工人已收尾时编排者代 commit");
  assert.match(a2.detail, /编排者代 commit/, "情形 2：decision_log 标注「编排者代 commit」");

  // 情形 3：(b) 含语义改动 → 打回；不绑 SHA；attempt 不推进、max_rounds 不消耗
  const b1 = auditableGate({ dirty: true, evidence: diffSemantic, classification: classifyDiff(diffSemantic).kind, workerAvailable: true });
  assert.equal(b1.action, "sendBack", "情形 3：(b) 处置 = 打回");
  assert.equal(b1.bindSha, false, "情形 3：不绑 SHA");
  assert.equal(b1.attemptAdvances, false, "情形 3：attempt 不推进");
  assert.equal(b1.consumesRounds, false, "情形 3：max_rounds 不消耗（洁净门整改 ≠ §2 重试）");
  assert.match(b1.detail, /禁止静默丢弃/, "情形 3：禁止静默丢弃");

  // 情形 4：(b) 仍要丢弃 → 必须先有 diff 原文证据 + Attention 条目
  const d = discardSemantic({ evidence: diffSemantic, attentionEntry: "丢弃 checks/x.check.mjs +20/-8（新增断言未说明）" });
  assert.equal(d.action, "discard", "情形 4：证据齐全才可丢弃");
  assert.equal(d.attemptAdvances, false, "情形 4：丢弃不推进 attempt");
  assert.equal(d.consumesRounds, false, "情形 4：丢弃不消耗 max_rounds");
  assert.ok(d.attention, "情形 4：Attention 条目必列");

  // —— 负例（必须真失败）：assert.throws 直接验证抛错，不依赖返回值 ——
  assert.throws(
    () => auditableGate({ dirty: true, evidence: null, classification: "a", workerAvailable: true }),
    /取证缺失/,
    "负例 1：无 diff 原文证据时处置必须抛错（取证缺失 ⇒ 不得处置）",
  );
  assert.throws(
    () => auditableGate({ dirty: true, evidence: "git status --short only，无 diff", classification: "a", workerAvailable: true }),
    /不得处置/,
    "负例 2：取证缺 git diff --stat 汇总行/hunk 时处置必须抛错",
  );
  assert.throws(
    () => discardSemantic({ evidence: diffSemantic, attentionEntry: null }),
    /Attention/,
    "负例 3：(b) 丢弃缺 Attention 条目必须抛错",
  );

  // 脏树上绑 SHA / 判 verified 的越权动作被契约守卫拒绝（既有负例保留）
  const contractGuard = (r) => {
    if (r.bindSha || r.verified) throw new Error("脏树上绑 head_sha/判 verified");
  };
  assert.throws(() => contractGuard({ bindSha: true, verified: false }), /脏树上绑 head_sha/, "脏树绑 head_sha 被拒");
  assert.throws(() => contractGuard({ bindSha: false, verified: true }), /脏树上绑 head_sha/, "脏树判 verified 被拒");
  assert.doesNotThrow(() => {
    contractGuard(a1);
    contractGuard(a2);
    contractGuard(b1);
  }, "洁净门下各处置结果都不绑 SHA 不判 verified");

  // 负例真实性证据：打印负例实际抛出的错误原文（防「gate 返回值正确导致负例永真通过」回归）
  for (const [name, fn] of [
    ["负例1 取证缺失", () => auditableGate({ dirty: true, evidence: null, classification: "a", workerAvailable: true })],
    ["负例2 取证缺 --stat/hunk", () => auditableGate({ dirty: true, evidence: "git status --short only，无 diff", classification: "a", workerAvailable: true })],
    ["负例3 丢弃缺 Attention", () => discardSemantic({ evidence: diffSemantic, attentionEntry: null })],
  ]) {
    try {
      fn();
      assert.fail(`${name}：负例未抛错（契约守卫失效）`);
    } catch (err) {
      if (err instanceof assert.AssertionError && err.message.includes("负例未抛错")) throw err;
      console.log(`  ✓ ${name} 真实抛出 → ${err.message}`);
    }
  }

  console.log("✓ 合成 drill 通过：(a) 格式化→commit 后绑 SHA；(a)+收尾→代 commit 记 decision_log；(b) 语义→打回不消耗轮次；(b) 丢弃须证据+Attention（负例真失败）");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  assertSkillContract();
}
