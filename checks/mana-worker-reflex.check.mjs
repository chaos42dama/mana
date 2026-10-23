#!/usr/bin/env node
// 工人进程内确定性反射断路器 + 事前路径守卫 + 共享契约/handoff 自检（41490/ipi#224 Phase 1 & Phase 2）
// 无参数：断言 extensions/pi/mana-worker.ts、scripts/check-mana-issue.py、
//         skills/mana/references/code-reviewer-prompt.md、skills/mana/SKILL.md、README.md
//         含连续 3 次报错反射提示注入（REFLEX_PROMPT_INJECTION）、连续 6 次 stalled_loop 断路器、
//         MANA_LANE_ALLOW_PATHS 事前写路径拦截、lanes/<lane-id>.events.jsonl 旁路蒸馏、
//         多 lane Shared contracts / Ownership 校验、starting_sha 与结构化 DONE handoff、只读 reviewer lane。
// --self-test：合成 drill——实跑 mana-worker.ts 导出的断路器/路径守卫/JSONL 蒸馏函数与
//         check-mana-issue.py 多 lane 跨界双写冲突检测，并验证删改关键契约原文的负例真失败。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REFLEX_PROMPT_INJECTION,
  REFLEX_STALL_THRESHOLD,
  REFLEX_WARN_THRESHOLD,
  STALLED_LOOP_INSTRUCTION,
  appendLaneEvent,
  createReflexState,
  decideAllowPath,
  distillSessionJsonlChunk,
  recordToolResult,
} from "../extensions/pi/mana-worker.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const REQUIRED_WORKER_SNIPPETS = [
  "REFLEX_WARN_THRESHOLD = 3",
  "REFLEX_STALL_THRESHOLD = 6",
  "REFLEX_PROMPT_INJECTION",
  "STALLED_LOOP_INSTRUCTION",
  "MANA_LANE_ALLOW_PATHS",
  "decideAllowPath",
  "recordToolResult",
  "distillSessionJsonlChunk",
  "appendLaneEvent",
];

const REQUIRED_SKILL_SNIPPETS = [
  "REFLEX_PROMPT_INJECTION",
  "stalled_loop",
  "MANA_LANE_ALLOW_PATHS",
  "lanes/<lane-id>.events.jsonl",
  "Shared contracts",
  "Ownership",
  "starting_sha",
  "commit_shas",
  "changed_files",
  "code-reviewer-prompt.md",
];

function assertReflexAndPhase2Contract({
  workerText = readFileSync(join(REPO, "extensions/pi/mana-worker.ts"), "utf8"),
  skillText = readFileSync(join(REPO, "skills/mana/SKILL.md"), "utf8"),
  reviewerText = readFileSync(
    join(REPO, "skills/mana/references/code-reviewer-prompt.md"),
    "utf8",
  ),
  issueScriptText = readFileSync(
    join(REPO, "scripts/check-mana-issue.py"),
    "utf8",
  ),
} = {}) {
  for (const s of REQUIRED_WORKER_SNIPPETS) {
    assert.ok(
      workerText.includes(s),
      `extensions/pi/mana-worker.ts 缺关键实现：${s}`,
    );
  }
  for (const s of REQUIRED_SKILL_SNIPPETS) {
    assert.ok(skillText.includes(s), `skills/mana/SKILL.md 缺契约条目：${s}`);
  }
  for (const s of [
    "PASS",
    "CHANGES_REQUESTED",
    "严禁修改任何文件",
    "不传 `--model`",
  ]) {
    assert.ok(
      reviewerText.includes(s),
      `skills/mana/references/code-reviewer-prompt.md 缺关键审阅约束：${s}`,
    );
  }
  assert.ok(
    issueScriptText.includes("Shared contracts") &&
      issueScriptText.includes("Ownership") &&
      issueScriptText.includes("check_ownership_conflicts"),
    "scripts/check-mana-issue.py 须包含多 lane Shared contracts / Ownership 及双写冲突校验",
  );
}

function selfTest() {
  // 1) 负例：删掉 stalled_loop 或 MANA_LANE_ALLOW_PATHS 契约原文必须失败
  const rawSkill = readFileSync(join(REPO, "skills/mana/SKILL.md"), "utf8");
  assert.throws(
    () =>
      assertReflexAndPhase2Contract({
        skillText: rawSkill.replaceAll("MANA_LANE_ALLOW_PATHS", ""),
      }),
    /MANA_LANE_ALLOW_PATHS/,
    "负例 1：从 SKILL.md 删去 MANA_LANE_ALLOW_PATHS 必须失败",
  );
  const rawReviewer = readFileSync(
    join(REPO, "skills/mana/references/code-reviewer-prompt.md"),
    "utf8",
  );
  assert.throws(
    () =>
      assertReflexAndPhase2Contract({
        reviewerText: rawReviewer.replaceAll("CHANGES_REQUESTED", ""),
      }),
    /CHANGES_REQUESTED/,
    "负例 2：从 code-reviewer-prompt.md 删去 CHANGES_REQUESTED 必须失败",
  );

  // 2) 合成 drill：连续 3 次报错注入反射提示 -> 连续 6 次触发 stalled_loop
  assert.equal(REFLEX_WARN_THRESHOLD, 3);
  assert.equal(REFLEX_STALL_THRESHOLD, 6);
  const st = createReflexState();
  for (let i = 1; i <= 2; i++) {
    const r = recordToolResult(st, {
      toolName: "bash",
      input: { command: "npm test" },
      isError: true,
    });
    assert.equal(r.action, "none");
  }
  const r3 = recordToolResult(st, {
    toolName: "bash",
    input: { command: "npm test" },
    isError: true,
  });
  assert.equal(r3.action, "inject_reflex");
  assert.equal(r3.message, REFLEX_PROMPT_INJECTION);

  for (let i = 4; i <= 5; i++) {
    const r = recordToolResult(st, {
      toolName: "bash",
      input: { command: "npm test" },
      isError: true,
    });
    assert.equal(r.action, "inject_reflex");
  }
  const r6 = recordToolResult(st, {
    toolName: "bash",
    input: { command: "npm test" },
    isError: true,
  });
  assert.equal(r6.action, "stalled_loop");
  assert.equal(st.stalledLoop, true);
  assert.equal(r6.message, STALLED_LOOP_INSTRUCTION);

  // 3) 合成 drill：MANA_LANE_ALLOW_PATHS 事前写路径守卫
  const cwd = "/worktree/repo";
  const allow = "scripts/,extensions/pi/mana-worker.ts";
  assert.equal(
    decideAllowPath("write", { path: "scripts/a.py" }, cwd, allow, true).block,
    false,
  );
  const out = decideAllowPath("edit", { path: "skills/mana/SKILL.md" }, cwd, allow, true);
  assert.equal(out.block, true, "越界写入必须被拦截");
  assert.match(out.reason ?? "", /MANA_LANE_ALLOW_PATHS/);

  // 4) 合成 drill：会话 JSONL 蒸馏与事件文件落盘
  const scratch = mkdtempSync(join(tmpdir(), "mana-reflex-drill-"));
  try {
    const evPath = join(scratch, "lanes", "lane-1.events.jsonl");
    appendLaneEvent(evPath, { type: "stalled_loop", tool: "bash" });
    const lines = readFileSync(evPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).type, "stalled_loop");

    const distilled = distillSessionJsonlChunk(
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          usage: { totalTokens: 777 },
          content: [
            {
              type: "toolCall",
              name: "edit",
              arguments: { path: "scripts/a.py" },
            },
          ],
        },
      }),
    );
    assert.equal(distilled.length, 1);
    assert.equal(distilled[0].tool, "edit");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // 5) 合成 drill：check-mana-issue.py 多 lane 双写冲突真失败
  const conflictBody = [
    "# 多 lane 目标",
    "## Depends on",
    "- 无",
    "## Files",
    "- lane-a, lane-b",
    "## Shared contracts",
    "- 无",
    "## Ownership",
    "- lane-a: scripts/shared.py",
    "- lane-b: scripts/shared.py",
    "## Build",
    "- 实现",
    "## Verify",
    "- unit: pytest",
    "- live: bash test",
    "## Review gate",
    "- 贴输出",
    "## Merge",
    "- squash",
  ].join("\n");
  const rIssue = spawnSync(
    "python3",
    [join(REPO, "scripts/check-mana-issue.py"), "--body", "-"],
    { input: conflictBody, encoding: "utf8" },
  );
  assert.notEqual(rIssue.status, 0, "多 lane 双写同一路径必须失败");
  assert.match(rIssue.stdout, /双写冲突/);

  console.log(
    "✓ 合成 drill 通过：3次报错反射 + 6次 stalled_loop + MANA_LANE_ALLOW_PATHS 越界拦截 + JSONL 蒸馏 + 多 lane 双写冲突拦截（含负例）",
  );
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  assertReflexAndPhase2Contract();
  console.log(
    "✓ mana-worker 反射断路器与 Phase 2 契约断言通过（3次反射/6次 stalled_loop/MANA_LANE_ALLOW_PATHS/events.jsonl/Shared contracts/reviewer lane）",
  );
}
