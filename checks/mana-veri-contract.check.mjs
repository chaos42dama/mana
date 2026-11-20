#!/usr/bin/env node
// /mana veri 只读验证技能生成入口契约自检（Issue #79）
// 无参数：断言 skills/mana/SKILL.md context 第 9 条 veri 契约原文（按内容匹配，不按行号）——
//         条目在位（init/doctor/status 三口 + frontmatter Triggers）、#78 三行决策（canonical
//         ~/.pi/agent/skills/verify-<app>/ + 共用软链 ~/.omp/agent/skills/verify-<app> + 写界）、
//         五步访谈（Surface/Run/Drive/Observe/Isolate）、SKILL.md 六节（Launch/Doctor/Drive/
//         Evidence/Cleanup/Helpers）、四 H2、账本四键、端到端实跑要求、命令模板不含 --model、
//         lane ≤ max_parallel_lanes、maintain 三结果、永不改产品代码。
//         环境变量 MANA_VERI_CONTRACT_SKILL 可覆盖待检 SKILL.md 路径（live drill 用）。
// --self-test：合成 drill——合成完整版最小片段必须通过；三条负例：
//         ① 删掉「cleanup 后证据仍在」→ 检查失败；② veri 命令模板插入 --model → 检查失败；
//         ③ 删 maintain「永不改产品代码」→ 检查失败。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 契约分组：required = 必须逐字在 SKILL.md 中的关键原文；negative = 附加负向/结构断言
const GROUPS = [
  {
    name: "条目在位",
    required: ["`/mana veri <目标>` 是只读验证技能生成入口", "init/doctor/status 三口"],
  },
  {
    name: "frontmatter Triggers",
    required: ["/mana veri"],
  },
  {
    name: "#78 决策 · canonical 与共用软链",
    required: [
      "canonical `~/.pi/agent/skills/verify-<app>/`",
      "软链 `~/.omp/agent/skills/verify-<app>`",
    ],
  },
  {
    name: "#78 决策 · 写界",
    required: [
      "工人在目标仓 `.pi/skills/verify-<app>/` 生成",
      "landing 由 orchestrator 安装 canonical",
    ],
  },
  {
    name: "init · 五步访谈",
    required: ["**Surface / Run / Drive / Observe / Isolate**", "只问代码库不问用户"],
  },
  {
    name: "init · SKILL.md 六节",
    required: ["**Launch / Doctor / Drive / Evidence / Cleanup / Helpers**", "无占位符"],
  },
  {
    name: "init · features 四 H2",
    required: [
      "`Sub-features` / `How to get to it (user POV)` / `Driving it with <harness>` / `Gotchas`",
      "3–5 个 feature 文件",
    ],
  },
  {
    name: "init · 账本四键",
    required: ["`last_verified_sha`", "`last_verified_at`", "`verdict`", "`prerequisites`"],
  },
  {
    name: "init · 端到端实跑",
    required: [
      "launch → doctor → drive 1 个 feature → 取证 → cleanup → 确认证据在 cleanup 后仍在",
      "**未被执行过的生成技只算 draft，不算交付**",
    ],
  },
  {
    name: "通用约束",
    required: [
      "lane 数 ≤ `max_parallel_lanes`",
      "**不传 `--model`**",
      "safe-guard `~/.pi/**` 用户级硬拦约束",
      "PR 上限 1",
    ],
  },
  {
    name: "maintain 三结果预示",
    required: ["`clean|changed|blocked`"],
  },
  {
    name: "maintain · 口与 Pass 链",
    required: [
      "**maintain**——功能地图例行对账",
      "skills/mana/references/veri-maintain-prompt.md",
      "0 定位目标",
      "1 索引卫生",
      "2 source wave",
      "3 reconcile",
      "4 live pass",
      "5 triage",
      "6 出 PR 或停",
    ],
  },
  {
    name: "maintain · 三结果与 partial 口径",
    required: [
      "`clean`（无 verify-<app> 或无需改）",
      "`changed`（只装已证实的修正，≤1 个 PR）",
      "`blocked`（逐项写明挡点）",
      "--source-only",
      "**partial**，不得当作 `clean`",
    ],
  },
  {
    name: "maintain · 边界",
    required: [
      "编辑范围只限 verify-<app> 自身目录",
      "orchestrator 独占驾驶",
      "product gap 记录上报、不进 PR",
    ],
  },
  {
    name: "生态边界",
    required: ["**永不改产品代码**"],
  },
];

// 取 context 第 9 条 veri 条目文本（到下一个同层编号条目为止），供负向断言圈定范围
function veriSection(skill, label) {
  const start = skill.indexOf("9. **veri**");
  assert.ok(start >= 0, `${label} 未找到 context 第 9 条 veri 条目`);
  const rest = skill.slice(start);
  const end = rest.search(/\n10\. /);
  return end >= 0 ? rest.slice(0, end) : rest;
}

function veriCommandTemplates(section, label) {
  const cmds = section.match(/`herdr (?:agent start|pane split)[^`]*`/g) ?? [];
  assert.ok(
    cmds.length >= 1,
    `${label}【veri 命令】：未找到 pane split / agent start 命令模板`,
  );
  return cmds;
}

function runAssertions(skill, label) {
  const frontmatter = skill.match(/^---\n[\s\S]*?\n---/)?.[0] ?? "";
  for (const g of GROUPS) {
    const scope = g.name === "frontmatter Triggers" ? frontmatter : skill;
    for (const snippet of g.required) {
      assert.ok(
        scope.includes(snippet),
        `${label} 缺关键原文【${g.name}】：\n  「${snippet}」\n  请核对 skills/mana/SKILL.md 该句是否被删改（本 check 按内容匹配，不按行号）`,
      );
    }
  }
  // 负向断言：veri 条目内命令模板不含 --model（不锁线契约，#20/#28/#50 同口径）
  const section = veriSection(skill, label);
  for (const cmd of veriCommandTemplates(section, label)) {
    assert.ok(
      !cmd.includes("--model"),
      `${label}【veri 命令】：命令模板含 --model（违反不锁线契约）：${cmd}`,
    );
  }
}

// 合成完整版：覆盖全部分组关键原文 + 命令模板的最小片段
function syntheticFull() {
  return [
    "---",
    'description: "Triggers: /mana veri。"',
    "---",
    "### context（不写业务代码）",
    "9. **veri**：`/mana veri <目标>` 是只读验证技能生成入口，含 init/doctor/status 三口，brief 用 `skills/mana/references/veri-generator-prompt.md`：",
    "   - **init**：只读 explorer lane **五步访谈**（**Surface / Run / Drive / Observe / Isolate**，只问代码库不问用户）；生成 SKILL.md 六节：**Launch / Doctor / Drive / Evidence / Cleanup / Helpers**，无占位符；features/README.md 索引 + 3–5 个 feature 文件，四 H2 = `Sub-features` / `How to get to it (user POV)` / `Driving it with <harness>` / `Gotchas`，接账本四键 `last_verified_sha` / `last_verified_at` / `verdict` / `prerequisites`；orchestrator 亲自端到端实跑 launch → doctor → drive 1 个 feature → 取证 → cleanup → 确认证据在 cleanup 后仍在。**落盘写死**：工人在目标仓 `.pi/skills/verify-<app>/` 生成（工作区内）；landing 由 orchestrator 安装 canonical `~/.pi/agent/skills/verify-<app>/`，并以软链 `~/.omp/agent/skills/verify-<app>` 共用。**未被执行过的生成技只算 draft，不算交付**。veri 生态**永不改产品代码**。",
    "   - **maintain**——功能地图例行对账（source wave brief 模板用 `skills/mana/references/veri-maintain-prompt.md`）：三结果 **`clean`（无 verify-<app> 或无需改）/ `changed`（只装已证实的修正，≤1 个 PR）/ `blocked`（逐项写明挡点）**。Pass 0–6：**0 定位目标**（无 verify-<app> 就停、指回 init）→ **1 索引卫生**（features/README.md 与 sibling 文件对账，修缺/多/重复/死条目）→ **2 source wave**（每 feature 一条只读 lane，峰值 ≤ `max_parallel_lanes`，不传 `--model`；孩子只读、不驱动、不改文件）→ **3 reconcile**（每 feature 有摘要即齐；除非有具体源码路径不得判缺失）→ **4 live pass**（orchestrator 独占驾驶：每 feature 至少一次；三不变量——doctor 不变量、证据不被 cleanup 吃掉、残留必须清理；`verified-unreachable` 必须写明具体前置条件与尝试路径）→ **5 triage**（doc drift / harness gap / product gap——product gap 记录上报、不进 PR）→ **6 出 PR 或停**（`changed` 时转 intake、经 `/mana run` 出 ≤1 PR）。`--source-only` 只跑 source wave，结果标 **partial**，不得当作 `clean`。编辑范围只限 verify-<app> 自身目录，**永不改产品代码**（行为不对 = doc drift 修地图或 product gap 上报，不纸盖）。",
    "   - 通用约束：lane 数 ≤ `max_parallel_lanes`；dispatch **不传 `--model`**；explore lane 只读（受 safe-guard `~/.pi/**` 用户级硬拦约束）；`/mana veri` 的 PR 上限 1。maintain 结果 `clean|changed|blocked`。dispatch 同 §2：`herdr agent start <veri-name> --kind pi --pane <pane-id>`。",
    "10. context 是只读入口。",
  ].join("\n");
}

function selfTest() {
  const label = "veri-contract self-test";
  // 正例：合成完整版必须通过
  runAssertions(syntheticFull(), `${label} · 合成完整版`);

  // 负例①：删掉「cleanup 后证据仍在」→ 失败
  const noEvidence =
    "orchestrator 亲自端到端实跑 launch → doctor → drive 1 个 feature → 取证 → cleanup。";
  assert.throws(
    () => runAssertions(syntheticFull().replace(/launch → doctor → drive 1 个 feature → 取证 → cleanup → 确认证据在 cleanup 后仍在/, "launch → doctor → drive 1 个 feature → 取证 → cleanup"), `${label} · 负例①`),
    /端到端实跑|cleanup/,
    `${label} 负例①未触发：删「cleanup 后证据仍在」应失败`,
  );
  assert.ok(!noEvidence.includes("cleanup 后证据仍在"));

  // 负例②：命令模板插入 --model → 失败
  assert.throws(
    () =>
      runAssertions(
        syntheticFull().replace(
          "`herdr agent start <veri-name> --kind pi --pane <pane-id>`",
          "`herdr agent start <veri-name> --kind pi --pane <pane-id> -- --model x/y`",
        ),
        `${label} · 负例②`,
      ),
    /--model/,
    `${label} 负例②未触发：命令模板插入 --model 应失败`,
  );

  // 负例③：删 maintain「永不改产品代码」→ 失败
  assert.throws(
    () =>
      runAssertions(
        syntheticFull().replace(/\*\*永不改产品代码\*\*/g, ""),
        `${label} · 负例③`,
      ),
    /永不改产品代码|生态边界/,
    `${label} 负例③未触发：删 maintain「永不改产品代码」应失败`,
  );
}

if (process.argv.includes("--self-test")) {
  selfTest();
  console.log("mana-veri-contract: self-test OK");
} else {
  const skillPath =
    process.env.MANA_VERI_CONTRACT_SKILL ||
    new URL("../skills/mana/SKILL.md", import.meta.url).pathname;
  runAssertions(readFileSync(skillPath, "utf8"), "mana-veri-contract");
  console.log("mana-veri-contract: OK");
}
