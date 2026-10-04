#!/usr/bin/env node
// 验证账本契约自检（Issue #24 子 Issue A）
// 无参数：断言 skills/mana/SKILL.md 含 head_sha schema 行、verdict 五枚举、
//         decisions.tsv 6 列表头、「新 SHA 作废旧结论」失效规则语义句。
// --self-test：合成 drill——按 SKILL.md 失效规则判定「改写 head_sha 后旧结论作废」，
//         并断言 decisions.tsv 表头与数据行列数一致（含负例）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const VERDICTS = ["live", "unit", "type-only", "blocked", "failed"];
const TSV_HEADER = "time<TAB>phase<TAB>decision<TAB>reason<TAB>evidence<TAB>result";

function assertSkillContract() {
  const skill = readFileSync(new URL("../skills/mana/SKILL.md", import.meta.url), "utf8");

  // 1) lanes 表 schema 行含 head_sha 与 verdict
  const schemaLine = skill.split("\n").find((l) => l.includes("lanes: [{"));
  assert.ok(schemaLine, "找到 §1 run 第 3 步 lanes 表 schema 行");
  assert.ok(schemaLine.includes("head_sha"), "schema 行含 head_sha");
  assert.ok(schemaLine.includes("verdict"), "schema 行含 verdict");

  // 2) verdict 五枚举齐全且逐一给出支撑语义
  const enumLine = skill.split("\n").find((l) => l.includes("`verdict` ∈"));
  assert.ok(enumLine, "找到 verdict 枚举行");
  for (const v of VERDICTS) assert.ok(enumLine.includes(`\`${v}\``), `verdict 枚举缺 \`${v}\``);
  assert.ok(skill.includes("git rev-parse HEAD"), "head_sha 取证命令写明");
  for (const v of VERDICTS) assert.ok(skill.includes(`\`${v}\`＝`), `verdict \`${v}\` 有支撑语义说明`);

  // 3) decisions.tsv 契约：路径 + 同源 + 6 列表头
  assert.ok(skill.includes(".mana/<run-id>/decisions.tsv"), "decisions.tsv 路径契约");
  assert.ok(skill.includes("同源同内容"), "与 state.decision_log 同源同内容");
  assert.ok(skill.includes(TSV_HEADER), "decisions.tsv 固定 6 列表头");
  assert.ok(skill.includes("工人不写它"), "工人不写 decisions.tsv");

  // 4) 失效规则语义句 + §3 监督循环点名
  assert.ok(skill.includes("旧 `head_sha` 上的 `verified`/`landed` 结论一律作废"), "失效规则语义句");
  const s3 = skill.split("## §3")[1] ?? "";
  assert.ok(s3.includes("失效规则") && s3.includes("head_sha"), "§3 监督循环第 2 步点名失效规则");

  // 5) §5 报告 Attention 段
  const s5 = skill.split("## §5")[1] ?? "";
  assert.ok(s5.includes("Attention"), "§5 报告含 Attention 段");
  assert.ok(s5.includes("无条目时写「无」"), "Attention 空条目语义");

  console.log("✓ SKILL.md 验证账本契约断言通过（head_sha/verdict/decisions.tsv/失效规则/Attention）");
}

function assertTsv(text, label) {
  const lines = text.split("\n");
  assert.deepEqual(lines[0].split("\t"), ["time", "phase", "decision", "reason", "evidence", "result"], `${label} 表头必须固定 6 列`);
  lines.slice(1).forEach((line, i) => assert.equal(line.split("\t").length, 6, `${label} 数据行 ${i + 1} 必须恰好 6 列`));
}

function selfTest() {
  // drill 1：合成最小 state（含 head_sha+verdict），按 SKILL.md 失效规则判定
  // 规则（§1 run 第 3 步）：结论只在其 head_sha 上有效；head_sha 改写后旧结论作废。
  const verdictStillValid = (lane, currentHead) =>
    lane.head_sha === currentHead && ["verified", "landed"].includes(lane.status);
  const lane = { id: "lane-1", head_sha: "a".repeat(40), verdict: "unit", status: "verified" };
  assert.equal(verdictStillValid(lane, lane.head_sha), true, "同 head_sha 上的 verified 结论有效");
  const newHead = "b".repeat(40);
  assert.equal(verdictStillValid(lane, newHead), false, "改写 head_sha 后旧结论一律作废（须新 SHA 重跑 acceptance）");

  // drill 2：合成 6 列 decisions.tsv，断言表头与数据行列数一致
  const tsv = [
    "time\tphase\tdecision\treason\tevidence\tresult",
    "2026-10-04T00:00:00Z\tsupervise\t按 RECOMMENDED 重派 lane-1\t工人 BLOCKED 属 needs_input\tQUESTION/RECOMMENDED 已记录\tok",
    "2026-10-04T00:05:00Z\tverify\t重验通过后更新 head_sha+verdict\t新 commit 作废旧结论\tgit rev-parse HEAD=b…f\tverified",
  ].join("\n");
  assertTsv(tsv, "合成 decisions.tsv");
  assert.throws(() => assertTsv(tsv + "\n缺\t一\t列\t的\t行", "负例"), /6 列/, "少列数据行必须被拒");

  console.log("✓ 合成 drill 通过：head_sha 改写作废旧结论 + decisions.tsv 6 列（含负例）");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  assertSkillContract();
}
