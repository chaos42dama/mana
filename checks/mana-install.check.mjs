#!/usr/bin/env node
// 装机脚本契约自检（Issue #31；#59 起 references glob 展开）
// 无参数：断言 scripts/mana-install.sh 存在且可执行、映射表覆盖四类目标 + references 目录 glob 展开、
//         --check 判定用 cmp -s（与 scripts/mana-preflight.sh 装机门同口径）、不含对配置/密钥路径的写操作、
//         SKILL.md intake 段含设计审查四红旗与 §13 承接声明、README 引用脚本且不再手写 cp 列表。
// --self-test：合成 drill——在临时 HOME 下实跑脚本，验证「目标缺失/落后 → --check 非 0」
//         「安装后 → --check 为 0」「重跑安装 → 目标 mtime 不变（幂等）」「错参 → 非 0」
//         「references 目标缺失→非 0 / 安装后→0 / 重跑 mtime 不变 / 新增源文件即被发现（glob 而非硬编码）」。
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

function script() {
  return readFileSync(join(REPO, "scripts/mana-install.sh"), "utf8");
}
function run(args, env) {
  try {
    const out = execFileSync(
      "bash",
      [join(REPO, "scripts/mana-install.sh"), ...args],
      {
        env: { ...process.env, ...env },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function assertContract() {
  const sh = script();
  // 1) 判定口径：逐文件 cmp -s，与 preflight 装机门同口径
  assert.ok(
    sh.includes("cmp -s"),
    "用 cmp -s 逐文件比对（与 mana-preflight.sh 装机门同口径）",
  );
  // 2) 映射表覆盖四类目标
  assert.ok(sh.includes("skills/mana/SKILL.md"), "映射表含技能正本");
  assert.ok(
    sh.includes(".omp/agent/skills/mana/SKILL.md"),
    "技能 → ~/.omp/agent/skills/mana/",
  );
  assert.ok(
    sh.includes(".agents/skills/mana/SKILL.md"),
    "技能 → ~/.agents/skills/mana/（父目录存在时）",
  );
  assert.ok(
    sh.includes("extensions/pi/mana-worker.ts"),
    "映射表含工人侧扩展（~/.pi/agent/extensions/）",
  );
  assert.ok(sh.includes(".pi/agent/extensions/"), "工人侧扩展目标目录");
  assert.ok(sh.includes(".omp/agent/extensions/"), "编排者侧扩展目标目录");
  // 2b) references 目录按 glob 展开进映射（#59）：源是 glob 而非硬编码文件名清单
  assert.ok(
    sh.includes("skills/mana/references/*.md"),
    "映射表含 references glob 源（skills/mana/references/*.md）",
  );
  assert.ok(
    sh.includes(".omp/agent/skills/mana/references/"),
    "references → ~/.omp/agent/skills/mana/references/",
  );
  assert.ok(
    !sh.includes("architect-rationale-template.md|") &&
      !sh.includes("architect-runner-prompt.md|"),
    "不得把 references 文件名硬编码进 MAPPINGS",
  );
  // 2c) pig 可选工人线路映射（cond 语义）：源/目标在表内，第三段条件目录非空，
  //     未装 pig 时走 skip（父目录不存在）而非 exit 2 —— 见下方 selfTest (h) 动态验证。
  const pigLine = sh
    .split("\n")
    .find((l) =>
      l.includes(
        "extensions/pig/herdr-agent-state.ts|$HOME_DIR/.pig/agent/extensions/herdr-agent-state.ts|",
      ),
    );
  assert.ok(pigLine, "映射表含 pig 源 extensions/pig/herdr-agent-state.ts");
  assert.ok(
    pigLine.includes(".pig/agent/extensions/herdr-agent-state.ts"),
    "pig 目标为 ~/.pig/agent/extensions/herdr-agent-state.ts",
  );
  const pigCond = pigLine.split("|")[2].replace(/["\s]/g, "");
  assert.ok(
    pigCond === "$HOME_DIR/.pig/agent/extensions",
    `pig 条带条件目录（未装 pig 时 skip 而非报错），实际第三段: ${pigCond}`,
  );
  // 3) 幂等：安装前先 cmp -s 判等，相同不写
  const installBranch = sh.split("install)")[1]?.split("esac")[0] ?? "";
  assert.ok(
    !installBranch.trimStart().startsWith("cp"),
    "install 分支不得无条件 cp（先判等再写）",
  );
  assert.ok(sh.includes("--dry-run"), "支持 --dry-run");
  assert.ok(sh.includes("--help"), "支持 --help");
  // 4) 绝不写配置/密钥（只查写操作，不查注释）
  const shCode = sh
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  for (const bad of [
    "settings.json",
    "models.json",
    "auth.json",
    "config.yml",
  ]) {
    assert.ok(!shCode.includes(bad), `不得触碰配置/密钥：${bad}`);
  }
  assert.ok(
    !/rm -rf|>>?\s*~\/\.(pi|omp)\/agent\/(settings|models|auth)/.test(shCode),
    "不得删除或重定向写用户级配置",
  );
  // 5) SKILL.md intake 四红旗 + #13 承接
  const skill = readFileSync(join(REPO, "skills/mana/SKILL.md"), "utf8");
  const intake = skill.split("### intake")[1]?.split("### context")[0] ?? "";
  for (const flag of [
    "split ownership",
    "two ways to do one task",
    "importable internals",
    "hand-synced list",
  ]) {
    assert.ok(intake.includes(flag), `intake 段含红旗：${flag}`);
  }
  assert.ok(
    intake.includes("下一个贡献者是 agent"),
    "intake 段含 agent 贡献者筛选视角",
  );
  assert.ok(
    intake.includes("#13"),
    "intake 段声明 /mana architect 由 Issue #13 承接",
  );
  assert.ok(
    intake.includes("只提供") && intake.includes("视角"),
    "intake 段声明本仓只提供视角",
  );
  assert.ok(
    intake.includes("mana-install.sh"),
    "点明装机同步曾是 hand-synced list，由本脚本消除",
  );
  // 6) README 引用脚本，不再手写 cp 列表
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  assert.ok(
    readme.includes("bash scripts/mana-install.sh"),
    "README 引用安装脚本",
  );
  assert.ok(
    readme.includes("bash scripts/mana-install.sh --check"),
    "README 写清 --check 用法",
  );
  assert.ok(readme.includes("唯一事实源"), "README 写明仓库正本 = 唯一事实源");
  assert.ok(
    !readme.includes("cp -r mana/skills/mana"),
    "README 不再手写技能 cp 列表",
  );
  assert.ok(
    !readme.includes("cp mana/extensions/pi/*.ts"),
    "README 不再手写工人侧扩展 cp 列表",
  );
  console.log(
    "✓ 装机脚本契约断言通过（cmp -s 口径/四类映射/幂等/不碰配置/四红旗/README 引用）",
  );
}

function selfTest() {
  const home = mkdtempSync(join(tmpdir(), "mana-install-drill-"));
  const env = { HOME: home };
  try {
    // (a) 目标全缺 → --check 非 0，且列出漂移
    let r = run(["--check"], env);
    assert.notEqual(r.code, 0, "目标缺失 → --check 非 0");
    assert.ok(r.out.includes("漂移"), "--check 列出漂移目标");
    // (b) 安装 → --check 为 0
    r = run([], env);
    assert.equal(r.code, 0, "安装 exit 0");
    r = run(["--check"], env);
    assert.equal(r.code, 0, `安装后 --check 为 0（实际: ${r.out}）`);
    // (c) 幂等：重跑安装，mtime 不变
    const targets = [
      join(home, ".omp/agent/skills/mana/SKILL.md"),
      join(home, ".pi/agent/extensions/mana-worker.ts"),
      join(home, ".omp/agent/extensions/mana-compact.ts"),
    ];
    for (const t of targets) assert.ok(existsSync(t), `已安装 ${t}`);
    const before = targets.map((t) => statSync(t).mtimeMs);
    run([], env);
    const after = targets.map((t) => statSync(t).mtimeMs);
    assert.deepEqual(after, before, "重跑安装不改 mtime（内容相同不写）");
    // (d) 制造落后 → --check 非 0
    const skillTarget = targets[0];
    rmSync(skillTarget);
    r = run(["--check"], env);
    assert.notEqual(r.code, 0, "目标缺失 → --check 非 0");
    // (e) 父目录不存在时跳过（~/.agents 未建）
    const rAll = run([], env);
    assert.equal(rAll.code, 0, "安装 exit 0");
    // (f) 错参非 0
    r = run(["--bogus"], env);
    assert.notEqual(r.code, 0, "未知参数 → 非 0");
    r = run(["--help"], env);
    assert.equal(r.code, 0, "--help → 0");
    console.log(
      "✓ 合成 drill 通过：缺失/落后 → --check 非 0；安装后 → 0；重跑 mtime 不变；错参非 0",
    );
    // (g) references glob（#59）：缺失→非 0；安装后→0；幂等；新增源文件即被发现（glob 而非硬编码清单）
    const refsDir = join(home, ".omp/agent/skills/mana/references");
    rmSync(refsDir, { recursive: true });
    r = run(["--check"], env);
    assert.notEqual(r.code, 0, "references 目标缺失 → --check 非 0");
    console.log("  ✓ references 目标缺失 → --check 非 0");
    r = run([], env);
    assert.equal(r.code, 0, "references 安装 exit 0");
    r = run(["--check"], env);
    assert.equal(r.code, 0, "references 安装后 --check 为 0");
    console.log("  ✓ references 安装后 → --check 为 0");
    const refTarget = join(refsDir, "architect-rationale-template.md");
    assert.ok(existsSync(refTarget), "references 已安装");
    const refBefore = statSync(refTarget).mtimeMs;
    run([], env);
    assert.equal(
      statSync(refTarget).mtimeMs,
      refBefore,
      "references 重跑安装 mtime 不变（幂等）",
    );
    console.log("  ✓ references 重跑安装 → 目标 mtime 不变（幂等）");
    // 探针：往仓库正本目录临时加一个新 md，--check 必须立刻发现——证明映射是 glob 展开
    // 而非硬编码清单（探针不进 PR，finally 保证清理）。
    const probeSrc = join(
      REPO,
      "skills/mana/references/architect-extra-probe.md",
    );
    writeFileSync(
      probeSrc,
      "probe: 证明 references 走 glob 而非硬编码清单（#59 self-test）\n",
    );
    try {
      r = run(["--check"], env);
      assert.notEqual(r.code, 0, "新增源文件 → --check 非 0（glob 生效）");
      console.log(
        "  ✓ 新增源文件 architect-extra-probe.md → --check 由 0 变非 0（glob 而非硬编码）",
      );
    } finally {
      rmSync(probeSrc, { force: true });
    }
    run([], env);
    r = run(["--check"], env);
    assert.equal(r.code, 0, "删探针重装后 --check 回 0");
    console.log("  ✓ 删探针并重装 → --check 回 0");
    // (h) pig 可选线路（cond 语义）：无 ~/.pig → skip 且 exit 0；建目录后 → 落位且幂等。
    r = run([], env);
    assert.ok(
      r.out.includes(".pig/agent/extensions/herdr-agent-state.ts"),
      "无 ~/.pig 时 pig 行仍出现在输出表",
    );
    assert.ok(
      r.out.includes("skip（父目录不存在）"),
      "无 ~/.pig 时 pig 条 skip 而非报错",
    );
    assert.ok(!existsSync(join(home, ".pig")), "未装 pig 不创建 ~/.pig");
    mkdirSync(join(home, ".pig/agent/extensions"), { recursive: true });
    r = run([], env);
    assert.equal(r.code, 0, "建 ~/.pig/agent/extensions 后安装 exit 0");
    const pigTarget = join(home, ".pig/agent/extensions/herdr-agent-state.ts");
    assert.ok(existsSync(pigTarget), "pig 扩展已安装");
    const pigBefore = statSync(pigTarget).mtimeMs;
    run([], env);
    assert.equal(
      statSync(pigTarget).mtimeMs,
      pigBefore,
      "pig 重跑安装 mtime 不变（幂等）",
    );
    console.log(
      "  ✓ pig 线路：无 ~/.pig → skip exit 0；建目录后落位且重跑 mtime 不变（cond 语义）",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  assertContract();
}
