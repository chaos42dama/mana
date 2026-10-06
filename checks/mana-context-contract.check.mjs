#!/usr/bin/env node
// /mana context how/why 只读取证入口契约自检（Issue #68）
// 无参数：断言 skills/mana/SKILL.md context 第 1 条 how 与第 2 条 why 的契约原文（按内容匹配，不按行号）——
//         how：复杂度分流（Simple 单条 explainer 不派 lane / Complex 派 explorer）、切面互不重叠、
//              lane 数受 `max_parallel_lanes` 约束、explorer 只取证不写散文、合成含数据流与归属边界且推测须标注、
//              结论默认不落盘（仅回复内交付）。
//         why：代码锚点先行（没有锚点不派）、每类一条 lane 不跨来源、缺口记录（Document the null）、
//              证据四档 direct/supported/inference/unknown、每条结论要带出处或档位标签、synthesizer 单条回收后跑。
//         两者共同：只读、不 push/merge/改 Issue、§0.8 回收双 `not_found`、命令模板不含 `--model`（负向）。
//         结构一致性：context 段头列举的入口条数 == 第 8 条声明的显式例外条数；
//         how 的并行切面数下界不高于预算上限（`max_parallel_lanes=1` 时不出现空区间）。
//         环境变量 MANA_CONTEXT_CONTRACT_SKILL 可覆盖待检 SKILL.md 路径（live drill 用）。
// --self-test：合成 drill——合成完整版最小片段必须通过；三条负例：
//         ① 删掉「没有锚点不派 lane」→ 检查失败；② explorer 命令模板插入 --model → 检查失败；
//         ③ 把 context 段头列举的入口条数与第 8 条例外条数改成不一致 → 检查失败。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 契约分组：required = 必须逐字在 SKILL.md 中的关键原文；negative = 附加负向/结构断言
const GROUPS = [
  {
    name: "how · 复杂度分流",
    required: [
      "**Simple**（单模块、小工具、窄问题如「函数 X 怎么工作」）→ **不派 lane**",
      "**Complex**（跨多文件/多服务、cross-cutting、全局架构概览）",
      "范围含糊先说出自己的理解再查",
    ],
  },
  {
    name: "how · 并行 explorer",
    required: [
      "只读 Pi explorer lane",
      "互不重叠的切面",
      "brief 用 `skills/mana/references/how-explorer-prompt.md`",
    ],
    negative(skill, label) {
      assert.ok(
        skill.includes("≤`max_parallel_lanes`"),
        `${label}【how 并行】：lane 数必须受 \`max_parallel_lanes\` 约束（不得写死具数）`,
      );
    },
  },
  {
    name: "how · 只取证不写散文",
    required: ["**只取证不写散文**", "不要猜名字，要读代码", "产出是证据集合"],
  },
  {
    name: "how · 合成心智模型",
    required: [
      "senior onboarding 级心智模型",
      "数据怎么流、归属与边界在哪、哪些是推测",
      "**推测必须显式标成推测**",
    ],
  },
  {
    name: "why · 谨慎调查者姿态",
    required: ["谨慎的调查者", "代码不携带动机", "不完整、有偏、常常缺失"],
  },
  {
    name: "why · 代码锚点先行",
    required: [
      "代码锚点先行",
      "**没有锚点不派 lane**",
      "`git blame -L <start>,<end> <file>`",
      "`git log --follow -p -- <file>`",
      "`git log --oneline -20 -- <file>`",
      "`git log -1 --format=%B <commit>`",
      "`gh pr view <n> --json title,body,author,createdAt,mergedAt,labels,closingIssuesReferences,comments,reviews`",
      "文件路径与行区间、关键符号、初始 commit 列表、从 merge commit 里抽出的 PR 号",
    ],
  },
  {
    name: "why · 每类一条 investigator",
    required: [
      "按**本机实际可用**的证据类别派 lane",
      "source control = `git` + `gh`",
      "issue tracker = `gh issue` / `gh pr`",
      "long-form docs = 仓库内文档与 session 记忆",
      "`codebase-memory` MCP 可用则单列一类",
      "**每个类别一条 lane，各管一个来源，不要让一条 lane cover 多个来源**",
      "brief 用 `skills/mana/references/why-investigator-prompt.md`",
      "同时 running 的 investigator ≤ `max_parallel_lanes`",
    ],
  },
  {
    name: "why · 缺口记录",
    required: ["写进缺口清单", "Document the null", "不得跳过搜索"],
  },
  {
    name: "why · 四档证据等级",
    required: [
      "`direct`",
      "`supported`",
      "`inference`",
      "`unknown`",
      "有人**白纸黑字**写过为什么",
      "有指向性证据但没直说",
      "推断，必须写出推断链",
      "查不到，明确说查不到",
      "brief 用 `skills/mana/references/why-epistemics.md`",
    ],
    negative(skill, label) {
      assert.ok(
        skill.includes("**每条结论要么带出处、要么带标签**"),
        `${label}【why 分级】：缺「每条结论要么带出处、要么带标签」硬约束`,
      );
      assert.ok(
        skill.includes("把 inference 写成 direct 属违规"),
        `${label}【why 分级】：缺「把 inference 写成 direct 属违规」红线`,
      );
    },
  },
  {
    name: "两者 · 共同硬边界",
    required: [
      "按 §0.8 回收并双 `not_found` 验证",
      "不 push/merge/改 Issue",
      "**不传 `--model`**",
      "只在回复里给（结论 + 关键证据 + 来源）",
      "只有用户明确要存档时才写 `.mana/<context-id>/`",
    ],
  },
  {
    name: "context · 例外清单计数一致",
    required: [],
    negative(skill, label) {
      assertExceptionCounts(skill, label);
      assertHowFacetBudget(skill, label);
    },
  },
];

function howCommandTemplates(skill, label) {
  const start = skill.indexOf("1. **how**");
  const end = start >= 0 ? skill.indexOf("3. **teach**") : -1;
  if (start < 0) throw new Error(`${label} 未找到 context 第 1 条 how 条目`);
  return (
    skill
      .slice(start, end < 0 ? undefined : end)
      .match(/`herdr (?:agent start|pane split)[^`]*`/g) ?? []
  );
}

function whyCommandTemplates(skill, label) {
  const start = skill.indexOf("2. **why**");
  const end = start >= 0 ? skill.indexOf("3. **teach**") : -1;
  if (start < 0) throw new Error(`${label} 未找到 context 第 2 条 why 条目`);
  return (
    skill
      .slice(start, end < 0 ? undefined : end)
      .match(/`herdr (?:agent start|pane split)[^`]*`/g) ?? []
  );
}

// 把「四」或「4」统一成阿拉伯数字条数
function statedCount(raw) {
  return /^[0-9]+$/.test(raw) ? Number(raw) : "零一二三四五六七八".indexOf(raw[0]);
}

// 修 #68 缺陷①：context 段头列举几条入口可开只读 lane，第 8 条就必须声明几个显式例外。
// 两处各自维护同一份数字 = hand-synced list 同族缺陷，用交叉断言把它变成Drill 可见的失败。
function assertExceptionCounts(skill, label) {
  const listed = skill.match(
    /仅第\s*([0-9]+(?:[/、][0-9]+)*)\s*条[^。\n]*?可开只读 lane/,
  );
  assert.ok(
    listed,
    `${label}【例外清单计数不一致】：context 段头缺「仅第 N 条 … 可开只读 lane」的入口列举，无法核对例外条数`,
  );
  const stated = skill.match(
    /是仅有的\s*([0-9]+|[一二三四五六七八]+)\s*个显式例外/,
  );
  assert.ok(
    stated,
    `${label}【例外清单计数不一致】：context 第 8 条缺「是仅有的 N 个显式例外」声明，无法核对例外条数`,
  );
  const nListed = listed[1].split(/[/、]/).length;
  const nStated = statedCount(stated[1]);
  assert.equal(
    nStated,
    nListed,
    `${label}【例外清单计数不一致】：段头列举 ${nListed} 条入口（${listed[1]}），第 8 条却说「${stated[1]}个显式例外」`,
  );
}

// 修 #68 缺陷②：how 的切面数不得写成「2–≤max_parallel_lanes」式区间——
// `max_parallel_lanes` 是可配字段（#25），预算为 1 时该区间为空、规则不可执行。
function assertHowFacetBudget(skill, label) {
  const start = skill.indexOf("1. **how**");
  const end = skill.indexOf("3. **teach**");
  const how = start >= 0 ? skill.slice(start, end > start ? end : undefined) : "";
  assert.ok(
    how.length > 0,
    `${label}【how 切面数】：未找到 context 第 1 条 how 条目`,
  );
  assert.ok(
    !/\d\s*[–—]\s*≤/.test(how),
    `${label}【how 切面数】：不得把切面数写成「2–≤max_parallel_lanes」式区间（预算为 1 时为空区间，规则不可执行）`,
  );
  assert.ok(
    /min\(2\s*,\s*`?max_parallel_lanes`?\)/.test(how) || /预算为\s*1/.test(how),
    `${label}【how 切面数】：须写 \`min(2, max_parallel_lanes)\` 或「预算为 1」兜底句，保证切面数下界不高于预算上限`,
  );
}

// 附加负向断言：how/why 段内所有命令模板不含 --model（不锁线契约，#20/#28/#50 同口径）
function assertContextContract(skill, label) {
  for (const g of GROUPS) {
    for (const snippet of g.required) {
      assert.ok(
        skill.includes(snippet),
        `${label} 缺关键原文【${g.name}】：\n  「${snippet}」\n  请核对 skills/mana/SKILL.md 该句是否被删改（本 check 按内容匹配，不按行号）`,
      );
    }
    if (g.negative) g.negative(skill, label);
  }
  for (const cmd of [
    ...howCommandTemplates(skill, label),
    ...whyCommandTemplates(skill, label),
  ]) {
    assert.ok(
      !cmd.includes("--model"),
      `${label}【how/why 命令】：命令模板含 --model（违反不锁线契约）：${cmd}`,
    );
  }
}

function selfTest() {
  // 合成完整版：覆盖全部分组关键原文 + 命令模板的最小片段
  const full = [
    "context（不写业务代码）",
    "### context（不写业务代码；仅第 1/2/6/7 条 how/why/architect/prototype 可开只读 lane）",
    "1. **how**：`/mana how <范围>` 以代码为证据；复杂度分流：范围含糊先说出自己的理解再查。**Simple**（单模块、小工具、窄问题如「函数 X 怎么工作」）→ **不派 lane**，一条只读 explainer 单程走完；**Complex**（跨多文件/多服务、cross-cutting、全局架构概览）→ 拆成 `min(2, max_parallel_lanes)` 个**互不重叠的切面**（同时 running 的 explorer ≤`max_parallel_lanes`，默认 2；预算为 1 时单条 explorer 走完 Complex），每条一个**只读 Pi explorer lane**（`herdr pane split --current --direction down --cwd <worktree-path> --env MANA_WORKER=1 --no-focus`、`herdr agent start <name> --kind pi --pane <pane-id> -- --exclude-tools ask_question`，**不传 `--model`**），brief 用 `skills/mana/references/how-explorer-prompt.md`。explorer **只取证不写散文**：不要猜名字，要读代码；产出是证据集合。**合成**：senior onboarding 级心智模型——数据怎么流、归属与边界在哪、哪些是推测；**推测必须显式标成推测**。按 §0.8 回收并双 `not_found` 验证；不 push/merge/改 Issue；结论只在回复里给（结论 + 关键证据 + 来源），只有用户明确要存档时才写 `.mana/<context-id>/`。",
    "2. **why**：`/mana why <范围>` 用**谨慎的调查者**姿态。代码不携带动机——动机在 commit、PR、Issue、文档、对话里，不完整、有偏、常常缺失。**代码锚点先行**：派 investigator 前必须拿到文件路径与行区间、关键符号、初始 commit 列表、从 merge commit 里抽出的 PR 号（`git blame -L <start>,<end> <file>`、`git log --follow -p -- <file>`、`git log --oneline -20 -- <file>`、`git log -1 --format=%B <commit>` 抽 `(#1234)`、`gh pr view <n> --json title,body,author,createdAt,mergedAt,labels,closingIssuesReferences,comments,reviews`）；**没有锚点不派 lane**。**并行取证**：按**本机实际可用**的证据类别派 lane（source control = `git` + `gh`；issue tracker = `gh issue` / `gh pr`；long-form docs = 仓库内文档与 session 记忆；`codebase-memory` MCP 可用则单列一类）。**每个类别一条 lane，各管一个来源，不要让一条 lane cover 多个来源**，brief 用 `skills/mana/references/why-investigator-prompt.md`；同时 running 的 investigator ≤ `max_parallel_lanes`，类别多于预算就回收一条再派一条；查无证据要**写进缺口清单**（Document the null），不得跳过搜索。**合成**：由一条只读 synthesizer lane（回收完 investigator 后启动），brief 用 `skills/mana/references/why-epistemics.md`，按其四档输出——`direct`（有人**白纸黑字**写过为什么，如 PR 正文写「修的是用户有 >1000 条时无法分页」）、`supported`（有指向性证据但没直说）、`inference`（推断，必须写出推断链）、`unknown`（查不到，明确说查不到）；**每条结论要么带出处、要么带标签**，把 inference 写成 direct 属违规。lane 同样按 §0.8 回收并双 `not_found` 验证；**不传 `--model`**、不 push/merge/改 Issue。",
    "8. context 是只读入口。不得在 context 静默派发 worker、修改 Issue 或扩大授权（architect 第 6 条、prototype 第 7 条与 how/why 的只读取证 lane——第 1/2 条 Complex/并行取证路径——是仅有的四个显式例外）。",
  ].join("\n");
  assertContextContract(full, "合成完整版");
  for (const g of GROUPS) console.log(`  ✓ ${g.name}`);
  console.log("  ✓ how/why 命令模板不含 --model");
  console.log("✓ 合成完整版：how/why 契约断言全部通过");

  // 负例 ①：删「代码锚点先行 / 没有锚点不派 lane」→ 检查失败
  const noAnchor = full
    .replace("**没有锚点不派 lane**", "")
    .replace("代码锚点先行", "");
  assert.throws(
    () => assertContextContract(noAnchor, "合成无锚版"),
    (err) => err.message.includes("代码锚点先行"),
    "删掉「代码锚点先行」后检查必须失败",
  );
  console.log(
    "  ✗ 删锚点失败：删「代码锚点先行」+「没有锚点不派 lane」→ 检查失败（负例证据）",
  );

  // 负例 ②：explorer 命令模板插入 --model → 负向断言必须失败
  const pinned = full.replace(
    "`herdr agent start <name> --kind pi --pane <pane-id> -- --exclude-tools ask_question`",
    "`herdr agent start <name> --kind pi --pane <pane-id> -- --model <m> --exclude-tools ask_question`",
  );
  assert.throws(
    () => assertContextContract(pinned, "合成锁线版"),
    (err) => err.message.includes("--model"),
    "how/why 命令模板插入 --model 后负向断言必须失败",
  );
  console.log(
    "  ✗ 插入 `--model` 失败：how/why 命令模板插入 --model → 检查失败（负例证据）",
  );

  // 负例 ③：段头列举 4 条入口、第 8 条却说「三个」例外 → 计数不一致必须失败
  const drifted = full.replace(
    "是仅有的四个显式例外",
    "是仅有的三个显式例外",
  );
  assert.ok(
    drifted !== full,
    "负例 ③ 的替换目标「是仅有的四个显式例外」未命中，drill 失效",
  );
  assert.throws(
    () => assertContextContract(drifted, "合成计数漂移版"),
    (err) => err.message.includes("计数不一致"),
    "段头入口条数与第 8 条例外条数不一致时检查必须失败",
  );
  console.log(
    "  ✗ 计数漂移失败：段头列举 4 条入口但第 8 条说「三个」例外 → 检查失败（负例证据）",
  );

  console.log(
    "✓ 合成 drill 通过：完整版过；删「代码锚点先行」失败；命令模板插入 --model 失败",
  );
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const skillPath =
    process.env.MANA_CONTEXT_CONTRACT_SKILL ||
    fileURLToPath(new URL("../skills/mana/SKILL.md", import.meta.url));
  assertContextContract(
    readFileSync(skillPath, "utf8"),
    `SKILL.md（${skillPath}）`,
  );
  console.log(
    "✓ SKILL.md how/why 只读取证契约断言通过（复杂度分流/锚点先行/每类一条/四档分级/缺口记录/不落盘/不锁线/双 not_found）",
  );
}
