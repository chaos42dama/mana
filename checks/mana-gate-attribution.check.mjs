#!/usr/bin/env node
// 「告警先归门禁」契约自检（Issue #124）
//
// 背景（实证）：nrc run nrc-9-live 里 pi-lens 把 Makefile 归为 shell 文件并派
// shellcheck, 报 "2 blocking, 12 warning"; 而该仓 `make lint` 只检查 *.sh
// (for f in *.sh), 从不检查 Makefile, 实测一直 clean。Pi worker 被那 2 条
// blocking 驱动反复"修"不存在的错误, 70+ 分钟零提交。
//
// 本 check 钉住两处契约, 防规则被后续编辑悄悄删掉:
//   §0.10  不变量: 告警先归门禁, 不在门禁内的诊断不构成必改项 (三步判读)
//   §2     brief 必给「真门禁清单」+ 显式声明宿主工具诊断不构成门禁
//
// --self-test: 负例 —— 把契约文本从内存副本中删掉, 断言检查函数真报错
// (负例必须真失败, 否则守卫恒真)。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function assertGateAttributionContract(skill) {
  const s0 = skill.split("## §0")[1]?.split("### run 单 owner 执行入口")[0] ?? "";
  const s2 = skill.split("## §2")[1]?.split("## §3")[0] ?? "";

  // --- §0.10 不变量 ---
  assert.ok(
    /^10\. \*\*告警先归门禁/m.test(s0),
    "§0 含第 10 条不变量「告警先归门禁」",
  );
  assert.ok(
    s0.includes("不在门禁内的诊断不构成必改项"),
    "§0.10 明确：不在门禁内的诊断不构成必改项",
  );
  assert.ok(
    s0.includes("门禁命令的实际退出码"),
    "§0.10 判据是门禁命令的实际退出码，不是工具面板红点",
  );
  // 三步判读齐全（① 归门禁 ② 门禁内才修 ③ 不在门禁内记决策段）
  for (const marker of ["① ", "② ", "③ "]) {
    assert.ok(s0.includes(marker), `§0.10 含判读步骤 ${marker.trim()}`);
  }
  assert.ok(
    s0.includes("未处理"),
    "§0.10 要求：不在门禁内的诊断记进交付『决策』段",
  );

  // --- §2 brief 要求 ---
  assert.ok(
    s2.includes("真门禁清单"),
    "§2 brief 要求列出「真门禁清单」",
  );
  assert.ok(
    s2.includes("不构成门禁"),
    "§2 brief 须显式声明：宿主工具诊断不构成门禁",
  );
  assert.ok(
    s2.includes("不要据此改代码"),
    "§2 brief 须给动作指引：不要据宿主工具告警改代码",
  );

  console.log(
    "✓ 告警归门禁契约通过：§0.10 三步判读 + §2 brief 真门禁清单与「不构成门禁」声明",
  );
}

function selfTest() {
  const real = readFileSync(
    new URL("../skills/mana/SKILL.md", import.meta.url),
    "utf8",
  );
  // 正例：真文件必须通过
  assertGateAttributionContract(real);
  console.log("  ✓ 正例：真 SKILL.md 通过");

  const negatives = [
    [
      "负例1 删 §0.10 整条",
      () => real.replace(/^10\. \*\*告警先归门禁[\s\S]*?(?=\n### )/m, ""),
      "含第 10 条不变量",
    ],
    [
      "负例2 删「不构成必改项」措辞",
      () => real.replaceAll("不在门禁内的诊断不构成必改项", "（已删）"),
      "不构成必改项",
    ],
    [
      "负例3 删 §2 真门禁清单要求",
      () => real.replaceAll("真门禁清单", "（已删）"),
      "真门禁清单",
    ],
    [
      "负例4 删 §2「不构成门禁」声明",
      () => real.replaceAll("不构成门禁", "（已删）"),
      "不构成门禁",
    ],
    [
      "负例5 删判据改为面板红点（改实际退出码措辞）",
      () => real.replaceAll("门禁命令的实际退出码", "工具面板红点"),
      "实际退出码",
    ],
  ];

  for (const [name, mutate, expect] of negatives) {
    const broken = mutate();
    assert.notEqual(broken, real, `${name}: 变异未生效`);
    try {
      assertGateAttributionContract(broken);
      assert.fail(`${name}: 负例未抛错（契约守卫失效）`);
    } catch (err) {
      if (
        err instanceof assert.AssertionError &&
        err.message.includes("负例未抛错")
      )
        throw err;
      console.log(`  ✓ ${name} 真实抛出 → ${err.message.split("\n")[0]}`);
    }
  }

  console.log(
    "✓ 合成 drill 通过：5 条负例各自真失败（删整条 / 删措辞 / 删 brief 两项要求 / 改判据）",
  );
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  assertGateAttributionContract(
    readFileSync(new URL("../skills/mana/SKILL.md", import.meta.url), "utf8"),
  );
}
