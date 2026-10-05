#!/usr/bin/env node
// /mana architect 只读设计入口契约自检（Issue #55）
// 无参数：断言 skills/mana/SKILL.md context 第 6 条 architect 契约原文（按内容匹配，不按行号）——
//         条目在位（只读设计入口 + 五阶段）、五阶段各自的关键句（A 接地 / B 独立 sketch /
//         C 交叉评审与合成 / D 交付 / E 偏离即信号）、2–3 条只读 Pi lane 且架构命令模板
//         不含 --model（负向断言）、四红旗被引用为筛选依据、产物落盘
//         .mana/<design-id>/design.md 与 candidates/<n>.md、只读边界（禁 push/merge/改 Issue/
//         写 run state + pane 双 not_found 回收 + 新建 design-id 不覆盖）、references 已随
//         mana-install.sh 装机分发的显式声明（#59 翻转，原为「未分发」声明）。
//         环境变量 MANA_ARCHITECT_CONTRACT_SKILL 可覆盖待检 SKILL.md 路径（live drill 用）。
// --self-test：合成 drill——合成完整版最小片段必须通过；三类负例：
//         ① 删掉某阶段（A 接地）关键原文 → 检查失败；② 架构命令模板插入 --model → 检查失败；
//         ③ 删掉「references 已随装机分发」声明 → 检查失败。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 契约分组：required = 必须逐字在 SKILL.md 中的关键原文；negative = 附加负向/结构断言
const GROUPS = [
  {
    name: "条目在位",
    required: ["`/mana architect <范围>` 是只读设计入口", "五阶段"],
  },
  {
    name: "五阶段 · A 接地",
    required: [
      "以 `/mana how` 的证据为准",
      "「命名了一个文件」不算接地",
      "必须给出追踪过的模型（数据流、归属、边界）",
      "纯 greenfield 且无周边系统要集成时可跳过 A",
      "产物里写明跳过理由",
    ],
  },
  {
    name: "五阶段 · B 独立 sketch",
    required: [
      "开 **2–3 条只读 Pi lane**",
      "结构上互不相同",
      "`skills/mana/references/architect-runner-prompt.md`",
      "**不传 `--model`**",
    ],
    negative(skill, label) {
      const section = architectSection(skill, label);
      const cmds =
        section.match(/`herdr (?:agent start|pane split)[^`]*`/g) ?? [];
      assert.ok(
        cmds.length >= 2,
        `${label}【architect 命令】：未找到 pane split / agent start 命令模板`,
      );
      for (const cmd of cmds) {
        assert.ok(
          !cmd.includes("--model"),
          `${label}【architect 命令】：架构命令模板含 --model（违反不锁线）：${cmd}`,
        );
      }
    },
  },
  {
    name: "五阶段 · C 交叉评审与合成",
    required: [
      "另一条**只读 lane",
      "按 intake「设计审查四红旗」逐一筛选每个候选",
      "命中红旗即否决",
      "按**接口深度**比较",
      "公开面越小、藏起的复杂度越多越好",
      "`Synthesis decision` 必须记录",
      "单候选直接通过不合规",
    ],
  },
  {
    name: "五阶段 · D 交付",
    required: [
      "`.mana/<design-id>/design.md`",
      "`skills/mana/references/architect-rationale-template.md` 八段",
      "`.mana/<design-id>/candidates/<n>.md`",
    ],
  },
  {
    name: "五阶段 · E 偏离即信号",
    required: ["偏离 sketch 要 surfaced 而不是默默吸收", "实现归 `/mana run`"],
  },
  {
    name: "只读边界",
    required: [
      "不改业务代码、不 push、不 merge、不改 Issue、不写 `.mana/<run-id>/state.json`",
      "只允许写 `.mana/<design-id>/`",
      "按 §0.8 回收并双 `not_found` 验证",
      "新建 `<design-id>`、不覆盖既有产物",
    ],
  },
  {
    name: "references 已装机声明",
    required: ["references 随 `scripts/mana-install.sh` 一起分发到用户级目录"],
  },
];

// 取 context 第 6 条 architect 条目文本（到下一个同层编号条目为止），供负向断言圈定范围
function architectSection(skill, label) {
  const start = skill.indexOf("6. **architect**");
  assert.ok(start >= 0, `${label} 未找到 context 第 6 条 architect 条目`);
  const rest = skill.slice(start);
  const end = rest.search(/\n7\. /);
  return end >= 0 ? rest.slice(0, end) : rest;
}

function assertArchitectContract(skill, label) {
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
  // 合成完整版：覆盖全部分组关键原文 + 一对架构命令模板的最小片段
  const full = [
    "6. **architect**：`/mana architect <范围>` 是只读设计入口——多线路独立 sketch，交叉评审后合成一份 design package。五阶段：",
    "   - **A 接地**：以 `/mana how` 的证据为准；「命名了一个文件」不算接地，必须给出追踪过的模型（数据流、归属、边界）。纯 greenfield 且无周边系统要集成时可跳过 A，但要在产物里写明跳过理由。",
    "   - **B 独立 sketch**：开 **2–3 条只读 Pi lane**：`herdr pane split --current --direction down --cwd <worktree-path> --env MANA_WORKER=1 --no-focus`，随后 `herdr agent start <arch-name> --kind pi --pane <pane-id> -- --exclude-tools ask_question`（**不传 `--model`**）。brief 用 `skills/mana/references/architect-runner-prompt.md`（references 随 `scripts/mana-install.sh` 一起分发到用户级目录）。要求各候选**结构上互不相同**的整体形状。",
    "   - **C 交叉评审与合成**：用**另一条**只读 lane 按 intake「设计审查四红旗」逐一筛选每个候选，命中红旗即否决；再按**接口深度**比较——公开面越小、藏起的复杂度越多越好。`Synthesis decision` 必须记录；单候选直接通过不合规。",
    "   - **D 交付**：design package 写 `.mana/<design-id>/design.md`（按 `skills/mana/references/architect-rationale-template.md` 八段），候选留 `.mana/<design-id>/candidates/<n>.md`。",
    "   - **E 偏离即信号**：偏离 sketch 要 surfaced 而不是默默吸收；本入口不写实现代码，实现归 `/mana run`。",
    "   只读边界：不改业务代码、不 push、不 merge、不改 Issue、不写 `.mana/<run-id>/state.json`（只允许写 `.mana/<design-id>/`）；按 §0.8 回收并双 `not_found` 验证；重复执行同一 `<范围>` 新建 `<design-id>`、不覆盖既有产物。",
    "7. context 是只读入口。",
  ].join("\n");
  assertArchitectContract(full, "合成完整版");
  for (const g of GROUPS) console.log(`  ✓ ${g.name}`);
  console.log("✓ 合成完整版：architect 契约 8 组断言全部通过");

  // 负例 ①：删掉某阶段（A 接地）关键原文 → 检查失败
  const missingPhase = full.replace("「命名了一个文件」不算接地", "");
  assert.throws(
    () => assertArchitectContract(missingPhase, "合成残缺版"),
    (err) => err.message.includes("「命名了一个文件」不算接地"),
    "删掉 A 接地关键原文后检查必须失败",
  );
  console.log("  ✗ 删阶段原文失败：删「A 接地」关键句 → 检查失败（负例证据）");

  // 负例 ②：架构命令模板插入 --model → 负向断言必须失败
  const pinned = full.replace(
    "`herdr agent start <arch-name> --kind pi --pane <pane-id> -- --exclude-tools ask_question`",
    "`herdr agent start <arch-name> --kind pi --pane <pane-id> --model <m> -- --exclude-tools ask_question`",
  );
  assert.throws(
    () => assertArchitectContract(pinned, "合成锁线版"),
    (err) => err.message.includes("--model"),
    "架构命令模板插入 --model 后负向断言必须失败",
  );
  console.log(
    "  ✗ 插入 `--model` 失败：architect 命令模板插入 --model → 检查失败（负例证据）",
  );

  // 负例 ③：删掉「references 已随装机分发」声明 → 检查失败（#59 翻转后的对应负例）
  const noDist = full.replace("references 随 `scripts/mana-install.sh` 一起分发到用户级目录", "");
  assert.throws(
    () => assertArchitectContract(noDist, "合成未声明版"),
    (err) => err.message.includes("references 随 `scripts/mana-install.sh`"),
    "删掉分发声明后检查必须失败",
  );
  console.log(
    "  ✗ 删分发声明失败：删「references 已随装机分发」声明 → 检查失败（负例证据）",
  );
  console.log("✓ 合成 drill 通过：完整版过；删阶段原文失败；插入 --model 失败；删分发声明失败");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const skillPath =
    process.env.MANA_ARCHITECT_CONTRACT_SKILL ||
    fileURLToPath(new URL("../skills/mana/SKILL.md", import.meta.url));
  assertArchitectContract(
    readFileSync(skillPath, "utf8"),
    `SKILL.md（${skillPath}）`,
  );
  console.log(
    "✓ SKILL.md architect 只读设计入口契约断言通过（五阶段/2–3 只读 lane 不锁线/四红旗筛选/产物落盘/只读边界/references 已装机声明）",
  );
}
