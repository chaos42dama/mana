#!/usr/bin/env node
// /mana prototype 只读原型入口契约自检（Issue #65）
// 无参数：断言 skills/mana/SKILL.md context 第 7 条 prototype 契约原文（按内容匹配，不按行号）——
//         条目在位（只读原型入口 + 五步）、五步各自的关键句（定决策 / 取材 / throwaway 构建 /
//         多变体+一个 switcher / 观测量即测试 / 交付）、与 architect 的分工（结构 vs 行为·交互·时序）、
//         throwaway 硬边界（禁 push/PR/merge/进主干 + scratch 可留但 lane 双 not_found 回收 +
//         不写 run state + 命令模板不含 --model 的负向断言）、产物路径 .mana/<probe-id>/probe.md
//         与 variants/<n>/、「不承诺自动截图」口径（UI 类只到能渲染 + 人工看）。
//         环境变量 MANA_PROTOTYPE_CONTRACT_SKILL 可覆盖待检 SKILL.md 路径（live drill 用）。
// --self-test：合成 drill——合成完整版最小片段必须通过；两条负例：
//         ① 删掉「原型代码永不进主干」→ 检查失败；② 原型命令模板插入 --model → 检查失败。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 契约分组：required = 必须逐字在 SKILL.md 中的关键原文；negative = 附加负向/结构断言
const GROUPS = [
  {
    name: "条目在位",
    required: ["`/mana prototype <决策问题>` 是只读原型入口", "五步"],
  },
  {
    name: "五步 · 定决策",
    required: [
      "先写清这个原型为哪个决定服务",
      "**没有决策就没有原型**",
      "要结构转 `/mana architect`",
      "要实现转 `/mana run`",
    ],
  },
  {
    name: "五步 · 取材",
    required: ["找先例、列 moodboard", "方向已定则跳过"],
  },
  {
    name: "五步 · throwaway 构建",
    required: [
      "隔离 scratch 目录（默认 `.mana/<probe-id>/`",
      "显式声明这是 throwaway",
      "不引生产框架、不写测试、不做抽象",
    ],
  },
  {
    name: "五步 · 多变体 + 一个 switcher",
    required: [
      "放在**一个开关**（按钮或按键）后面",
      "每变体有标签",
      "单变体不算原型价值",
    ],
  },
  {
    name: "五步 · 观测量即测试",
    required: [
      "输出、时序、计数",
      "「能渲染 + 人工看」",
      "**不承诺自动截图**",
    ],
  },
  {
    name: "五步 · 交付",
    required: [
      "取舍与**建议**",
      "明说原型是 throwaway",
      "`.mana/<probe-id>/probe.md` + `variants/<n>/`",
      "建议方向交回 `/mana architect`",
    ],
  },
  {
    name: "与 architect 的分工",
    required: [
      "architect 决定**结构**、不写代码",
      "prototype 决定**行为/交互/时序**",
      "原型永不进主干、不得被当作实现复用",
      "两者都不 landing",
    ],
  },
  {
    name: "throwaway 硬边界",
    required: [
      "原型代码永不进主干（不 push、不建 PR、不 merge、不落业务目录）",
      "按 §0.8 回收并双 `not_found` 验证",
      "不写 `.mana/<run-id>/state.json`",
      "不改 Issue",
      "**不传 `--model`**",
    ],
    negative(skill, label) {
      const section = prototypeSection(skill, label);
      const cmds =
        section.match(/`herdr (?:agent start|pane split)[^`]*`/g) ?? [];
      assert.ok(
        cmds.length >= 2,
        `${label}【prototype 命令】：未找到 pane split / agent start 命令模板`,
      );
      for (const cmd of cmds) {
        assert.ok(
          !cmd.includes("--model"),
          `${label}【prototype 命令】：原型命令模板含 --model（违反不锁线）：${cmd}`,
        );
      }
    },
  },
];

// 取 context 第 7 条 prototype 条目文本（到下一个同层编号条目为止），供负向断言圈定范围
function prototypeSection(skill, label) {
  const start = skill.indexOf("7. **prototype**");
  assert.ok(start >= 0, `${label} 未找到 context 第 7 条 prototype 条目`);
  const rest = skill.slice(start);
  const end = rest.search(/\n8\. /);
  return end >= 0 ? rest.slice(0, end) : rest;
}

function assertPrototypeContract(skill, label) {
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
  // 合成完整版：覆盖全部分组关键原文 + 一对原型命令模板的最小片段
  const full = [
    "7. **prototype**：`/mana prototype <决策问题>` 是只读原型入口——开独立只读 Pi lane（dispatch 同 §2：`herdr pane split --current --direction down --cwd <worktree-path> --env MANA_WORKER=1 --no-focus`，随后 `herdr agent start <probe-name> --kind pi --pane <pane-id> -- --exclude-tools ask_question`，**不传 `--model`**；brief 用 `skills/mana/references/prototype-switcher-prompt.md`）用最轻的栈做 throwaway 多变体原型，用观测量回答一个具体决策问题，原型永不进主干。五步：",
    "   - **定决策**：先写清这个原型为哪个决定服务；**没有决策就没有原型**——要结构转 `/mana architect`，要实现转 `/mana run`。",
    "   - **取材**：找先例、列 moodboard 供人挑方向；方向已定则跳过并写明。",
    "   - **throwaway 构建**：隔离 scratch 目录（默认 `.mana/<probe-id>/`，自指定 scratch 路径必须记进产物），不引生产框架、不写测试、不做抽象；显式声明这是 throwaway。",
    "   - **多变体 + 一个 switcher**：各变体放在**一个开关**（按钮或按键）后面，每变体有标签；单变体不算原型价值。",
    "   - **观测量即测试**：CLI/脚本类用输出、时序、计数；UI 类只做到「能渲染 + 人工看」，**不承诺自动截图**。",
    "   - **交付**：呈现变体、证据、取舍与**建议**，明说原型是 throwaway；产物写 `.mana/<probe-id>/probe.md` + `variants/<n>/`；建议方向交回 `/mana architect`。",
    "   与 architect 的分工：architect 决定**结构**、不写代码；prototype 决定**行为/交互/时序**、原型永不进主干、不得被当作实现复用；两者都不 landing。",
    "   硬边界：原型代码永不进主干（不 push、不建 PR、不 merge、不落业务目录）；scratch 目录可留，但按 §0.8 回收并双 `not_found` 验证；不写 `.mana/<run-id>/state.json`；不改 Issue。",
    "8. context 是只读入口。",
  ].join("\n");
  assertPrototypeContract(full, "合成完整版");
  for (const g of GROUPS) console.log(`  ✓ ${g.name}`);
  console.log("✓ 合成完整版：prototype 契约 9 组断言全部通过");

  // 负例 ①：删掉「throwaway 不得进主干」关键原文 → 检查失败
  const noBoundary = full.replace("原型代码永不进主干（不 push、不建 PR、不 merge、不落业务目录）", "");
  assert.throws(
    () => assertPrototypeContract(noBoundary, "合成失界版"),
    (err) => err.message.includes("原型代码永不进主干"),
    "删掉「原型代码永不进主干」后检查必须失败",
  );
  console.log(
    "  ✗ 删硬边界失败：删「原型代码永不进主干（不 push、不建 PR、不 merge、不落业务目录）」→ 检查失败（负例证据）",
  );

  // 负例 ②：原型命令模板插入 --model → 负向断言必须失败
  const pinned = full.replace(
    "`herdr agent start <probe-name> --kind pi --pane <pane-id> -- --exclude-tools ask_question`",
    "`herdr agent start <probe-name> --kind pi --pane <pane-id> --model <m> -- --exclude-tools ask_question`",
  );
  assert.throws(
    () => assertPrototypeContract(pinned, "合成锁线版"),
    (err) => err.message.includes("--model"),
    "原型命令模板插入 --model 后负向断言必须失败",
  );
  console.log(
    "  ✗ 插入 `--model` 失败：prototype 命令模板插入 --model → 检查失败（负例证据）",
  );

  console.log("✓ 合成 drill 通过：完整版过；删「不进主干」硬边界失败；插入 --model 失败");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const skillPath =
    process.env.MANA_PROTOTYPE_CONTRACT_SKILL ||
    fileURLToPath(new URL("../skills/mana/SKILL.md", import.meta.url));
  assertPrototypeContract(readFileSync(skillPath, "utf8"), `SKILL.md（${skillPath}）`);
  console.log(
    "✓ SKILL.md prototype 只读原型入口契约断言通过（五步/不锁线/分工/硬边界/产物落盘/不承诺截图口径）",
  );
}
