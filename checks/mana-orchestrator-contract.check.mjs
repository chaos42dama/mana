#!/usr/bin/env node
// 编排者侧契约自检（Issue #50）
// 无参数：断言 skills/mana/SKILL.md 编排者侧契约原文（按内容匹配，不按行号）——
//         CLI 形态（agent prompt 位置参数在前/--timeout 毫秒且须配 --wait、agent wait 可带
//         --timeout、pane split --env MANA_WORKER=1 --no-focus、agent start --kind pi --pane
//         -- --exclude-tools ask_question 且命令模板不含 --model）、超时 ≠ 未投递（先 agent
//         get/read，不得重复 prompt）、不锁线（§2 dispatch「不带 --model」+ §5 自检断言句）、
//         交付洁净（§3 绑 SHA 前先查工作树 + git status --short + brief 模板附原文）、
//         回收双验证（agent get + pane get 双 not_found）。
//         环境变量 MANA_ORCH_CONTRACT_SKILL 可覆盖待检 SKILL.md 路径（live drill 用）。
//         注：`herdr worktree remove --workspace <ID>` 形态未在 SKILL.md 成文（Issue #50 核实），
//         故不断言，待原文落文后再补。
// --self-test：合成 drill——在 /tmp 合成完整版/残缺版两份最小 SKILL.md 片段，逐组断言：
//         完整版必须通过；每组删掉一条关键原文后检查必须失败（负例证据）；另断言出现含
//         --model 的 agent start 命令模板时，不锁线负向断言必须失败。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 契约分组：required = 必须逐字在 SKILL.md 中的关键原文；negative = 附加负向/结构断言
const GROUPS = [
  {
    name: "CLI 形态 · agent prompt",
    required: [
      "`herdr agent prompt <TARGET> <TEXT> --wait --timeout <MS>`",
      "位置参数必须在前、选项在后",
      "`--timeout` 单位是**毫秒**且必须与 `--wait` 同用",
      "`--timeout requires --wait`",
    ],
  },
  {
    name: "CLI 形态 · agent wait",
    required: ["`herdr agent wait <worker>`（可带 `--timeout`）"],
  },
  {
    name: "CLI 形态 · pane split / agent start",
    required: [
      "`herdr pane split --current --direction down --cwd <worktree-path> --env MANA_WORKER=1 --no-focus`",
      "`herdr agent start <agent-name> --kind pi --pane <pane-id> -- --exclude-tools ask_question`",
    ],
    negative(skill, label) {
      const startCmds = skill.match(/`herdr agent start [^`]*`/g) ?? [];
      assert.ok(
        startCmds.length > 0,
        `${label}【CLI 形态】：未找到 \`herdr agent start\` 命令模板`,
      );
      for (const cmd of startCmds) {
        assert.ok(
          !cmd.includes("--model"),
          `${label}【CLI 形态】：agent start 命令模板含 --model（违反不锁线）：${cmd}`,
        );
      }
      const dispatch = startCmds.find((c) =>
        c.includes("--exclude-tools ask_question"),
      );
      assert.ok(
        dispatch?.includes("--kind pi") && dispatch?.includes("--pane"),
        `${label}【CLI 形态】：未找到 dispatch 完整 agent start 模板（--kind pi --pane … -- --exclude-tools ask_question）`,
      );
    },
  },
  {
    name: "超时 ≠ 未投递",
    required: [
      "`agent_prompt_stalled` 或 wait timeout 不代表未投递或失败",
      "先 `herdr agent get/read`",
      "不得重复 prompt",
    ],
  },
  {
    name: "不锁线（--model 禁令）",
    required: [
      "**不带 `--model`**——线路由 pi 启动时按配置默认顺势使用",
      "`herdr agent start` 命令**不含** `--model`",
    ],
  },
  {
    name: "交付洁净",
    required: [
      "`DONE` 是 claim，且绑 SHA 前先查工作树",
      "先在该 lane worktree 跑 `git status --short`",
      "未提交则写明工作树脏，并逐字附 `git status --short` 原文",
    ],
  },
  {
    name: "回收双验证",
    required: [
      "`herdr agent get <name>` 和 `herdr pane get <pane-id>` 必须均为 `not_found`",
      "再以 `agent get`、`pane get` 双 `not_found` 验证",
    ],
  },
];

function assertOrchestratorContract(skill, label) {
  for (const g of GROUPS) {
    for (const snippet of g.required) {
      assert.ok(
        skill.includes(snippet),
        `${label} 缺关键原文【${g.name}】：\n  「${snippet}」\n  请核对 skills/mana/SKILL.md 该句是否被删改（本 check 按内容匹配，不按行号）`,
      );
    }
    if (g.negative) g.negative(skill, label);
  }
}

function selfTest() {
  // 合成完整版：关键原文逐字摘自 skills/mana/SKILL.md（#50 时点）
  const full = [
    "- 每条需持续会话的 lane：先从当前 orchestrator pane 用 `herdr pane split --current --direction down --cwd <worktree-path> --env MANA_WORKER=1 --no-focus` 创建本 run 专属 pane。读取返回的 `workspace_id`、`pane_id` 后直接启动：`herdr agent start <agent-name> --kind pi --pane <pane-id> -- --exclude-tools ask_question`（`--` 之后是 pi 原生参数；**不带 `--model`**——线路由 pi 启动时按配置默认顺势使用）。",
    "- `agent_prompt_stalled` 或 wait timeout 不代表未投递或失败；先 `herdr agent get/read`，不得重复 prompt。",
    "- 未提交则写明工作树脏，并逐字附 `git status --short` 原文",
    "- `herdr agent prompt` 参数形态：`herdr agent prompt <TARGET> <TEXT> --wait --timeout <MS>`——位置参数必须在前、选项在后（写反报 `unknown option: <text>`）；`--timeout` 单位是**毫秒**且必须与 `--wait` 同用（否则报 `--timeout requires --wait`）。",
    "- 优先用 `herdr agent wait <worker>`（可带 `--timeout`）事件驱动阻塞等待来收 lane 事件。",
    "2. `DONE` 是 claim，且绑 SHA 前先查工作树：orchestrator 先在该 lane worktree 跑 `git status --short`——非空则不绑 `head_sha`、不判 `verified`。",
    "4. `verified` lane 立即 `herdr pane close <pane-id>`，再以 `agent get`、`pane get` 双 `not_found` 验证，状态置 `reclaimed`。",
    "- lane 验收后关闭 pane：随后 `herdr agent get <name>` 和 `herdr pane get <pane-id>` 必须均为 `not_found`。",
    "- run 自检：`herdr agent start` 命令**不含** `--model`。",
  ].join("\n");

  // 正例：完整版必须通过
  assertOrchestratorContract(full, "合成完整版");
  for (const g of GROUPS) console.log(`  ✓ ${g.name}`);
  console.log("✓ 合成完整版：编排者契约 7 组断言全部通过");

  // 负例：每组删掉一条关键原文 → 检查必须失败
  for (const g of GROUPS) {
    const broken = full.replace(g.required[0], "");
    assert.throws(
      () => assertOrchestratorContract(broken, "合成残缺版"),
      (err) => err.message.includes(g.required[0].slice(0, 20)),
      `${g.name}：删关键原文后检查必须失败`,
    );
    console.log(`  ✗ ${g.name}：删「${g.required[0]}」→ 检查失败（负例证据）`);
  }

  // 额外负例：另加一条含 --model 的 agent start 命令模板 → 不锁线负向断言必须失败
  const pinned =
    full +
    "\n- `herdr agent start <name> --kind pi --pane <p> --model <m> -- --exclude-tools ask_question`";
  assert.throws(
    () => assertOrchestratorContract(pinned, "合成锁线版"),
    (err) => err.message.includes("--model"),
    "agent start 命令插入 --model 后负向断言必须失败",
  );
  console.log(
    "  ✗ 不锁线（负向）：agent start 命令模板插入 --model → 检查失败（负例证据）",
  );

  console.log("✓ 合成 drill 通过：完整版过；每组残缺版败；--model 锁线负例败");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const skillPath =
    process.env.MANA_ORCH_CONTRACT_SKILL ||
    fileURLToPath(new URL("../skills/mana/SKILL.md", import.meta.url));
  assertOrchestratorContract(
    readFileSync(skillPath, "utf8"),
    `SKILL.md（${skillPath}）`,
  );
  console.log(
    "✓ SKILL.md 编排者侧契约断言通过（CLI 形态/超时≠未投递/不锁线/交付洁净/回收双验证）",
  );
}
