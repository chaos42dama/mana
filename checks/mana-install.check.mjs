#!/usr/bin/env node
// 装机脚本契约自检（Issue #89）：映射、README 表必须相等；git 内另校验正本跟踪集。
// --self-test 另实跑沙箱装机、幂等、条件接线，以及映射/README 各一组注入负例。
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  readdirSync,
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

const MIRROR_EXCLUDES = new Set([".gitignore"]);

function expandTrackedSources(sources) {
  const files = new Set();
  for (const source of sources) {
    const path = join(REPO, source);
    if (statSync(path).isFile()) {
      files.add(source);
      continue;
    }
    const walk = (dir, prefix) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) walk(join(dir, entry.name), rel);
        else if (entry.isFile()) files.add(rel);
      }
    };
    walk(path, source);
  }
  return files;
}

function parseShellSources(sourceText, name) {
  const start = sourceText.indexOf(`${name}=`);
  assert.notEqual(start, -1, `装机脚本声明 ${name}`);
  const open = sourceText.indexOf("(", start);
  const end = sourceText.indexOf(")", open);
  return sourceText.slice(open + 1, end).trim().split(/\s+/);
}

function expandReadmeMappings(readmeText) {
  const rows = [...readmeText.matchAll(/^\| `([^`]+)` \| `([^`]+)`/gm)];
  assert.ok(rows.length, "README 含安装映射表");
  const sources = new Set();
  const targets = new Set();
  for (const [, source, target] of rows) {
    const root = source.endsWith("/**") ? source.slice(0, -3) : source;
    for (const file of expandTrackedSources([root])) {
      sources.add(file);
      const relative = file === root ? "" : file.slice(root.length + 1);
      const destination = target.replace(/^~\//, "");
      let mappedTarget = destination;
      if (destination.endsWith("/**")) mappedTarget = `${destination.slice(0, -2)}${relative}`;
      else if (destination.endsWith("/")) mappedTarget = `${destination}${relative}`;
      targets.add(mappedTarget);
    }
  }
  return { sources, targets };
}

function gitTrackedFiles() {
  const sourceRoot = process.env.MANA_SRC || REPO;
  const probe = execFileSync("git", ["-C", sourceRoot, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  assert.equal(probe, "true", "git 上下文探测结果");
  return new Set(
    execFileSync("git", ["-C", sourceRoot, "ls-files"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")
      .filter((file) => file && !MIRROR_EXCLUDES.has(file)),
  );
}

function assertMirrorCoverage({ sourceText = script(), readmeText = readFileSync(join(REPO, "README.md"), "utf8") } = {}) {
  const mirrorSources = parseShellSources(sourceText, "MIRROR_SOURCES");
  const skillRootSources = parseShellSources(sourceText, "SKILL_ROOT_SOURCES");
  const mirrorFiles = expandTrackedSources(mirrorSources);
  const skillRootFiles = expandTrackedSources(skillRootSources);
  const documented = expandReadmeMappings(readmeText);
  assert.deepEqual(
    [...documented.sources].sort(),
    [...mirrorFiles].sort(),
    "README 装机表源集与映射覆盖集一致",
  );

  const targets = new Set([
    ...[...mirrorFiles].map((file) => `.omp/agent/skills/mana/${file}`),
    ...[...skillRootFiles].map((file) => `.omp/agent/skills/mana/${file.slice("skills/mana/".length)}`),
  ]);
  const wiringStart = sourceText.indexOf("# 既有接线目录保持不变");
  const wiring = sourceText.slice(wiringStart).split("MAPPINGS+=(")[1]?.split(")")[0] ?? "";
  for (const line of wiring.split("\n")) {
    const fields = line.trim().replace(/^\"|\"$/g, "").split("|");
    if (fields[1]?.startsWith("$HOME_DIR/") && !fields[1].includes("$_rel")) {
      targets.add(fields[1].slice("$HOME_DIR/".length));
    }
  }
  assert.deepEqual([...documented.targets].sort(), [...targets].sort(), "README 装机表与映射目标集一致");

  let tracked;
  try {
    tracked = gitTrackedFiles();
  } catch (error) {
    const reason = error.code === "ENOENT" ? "git 命令不可用" : "当前路径及 MANA_SRC 非 git 工作树或 git rev-parse/ls-files 失败";
    console.warn(`WARN：${reason}；该子断言已跳过，需在正本仓或 MANA_SRC 指向的仓内复验`);
    return mirrorFiles.size;
  }
  assert.deepEqual(
    [...mirrorFiles].sort(),
    [...tracked].sort(),
    "主镜像源覆盖正本跟踪集（排除 .gitignore）",
  );
  return tracked.size;
}

function assertContract() {
  const sh = script();
  // 1) 判定口径：逐文件 cmp -s，与 preflight 装机门同口径
  assert.ok(
    sh.includes("cmp -s"),
    "用 cmp -s 逐文件比对（与 mana-preflight.sh 装机门同口径）",
  );
  // 2) 目录镜像来源与真实正本集合机械对齐
  assert.equal(assertMirrorCoverage(), 47, "正本仓布局覆盖 47 个跟踪文件（排除 .gitignore）");
  assert.ok(sh.includes("MIRROR_SOURCES=(skills/mana scripts extensions checks docs README.md AGENTS.md LICENSE)"), "正本仓布局按目录/文件 glob 展开");
  assert.ok(sh.includes("SKILL_ROOT_SOURCES=(skills/mana/SKILL.md skills/mana/references)"), "技能根映射含入口与 references");
  assert.ok(sh.includes("skills/mana/SKILL.md"), "映射表含技能正本");
  assert.ok(
    sh.includes(".omp/agent/skills/mana/$_rel"),
    "正本仓布局保留源相对路径",
  );
  assert.ok(
    sh.includes("_target_rel"),
    "技能入口与 references 另落技能根",
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
  assert.ok(sh.includes("find \"$REPO_ROOT/$_source\" -type f"), "映射递归展开目录文件");
  assert.ok(sh.includes("chmod --reference"), "镜像保留正本执行位");
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
  assert.ok(readme.includes("`scripts/**`"), "README 脚本清单注明 scripts 目录镜像");
  assert.ok(readme.includes("`extensions/**`"), "README 扩展清单注明 extensions 目录镜像");
  assert.ok(readme.includes("`checks/**`"), "README 契约清单注明 checks 目录镜像");
  assert.ok(readme.includes("`docs/**`"), "README 文档清单注明 docs 目录镜像");
  assert.ok(readme.includes("~/.omp/agent/skills/mana/scripts/"), "README 明示全局脚本目标目录");
  assert.ok(readme.includes("MANA_SRC") && readme.includes("MANA_REPO"), "README 说明源与目标仓环境变量");
  assert.ok(readme.includes("镜像集明确排除 `.gitignore`"), "README 明示镜像排除项");
  assert.ok(readme.includes("跟踪集覆盖率子断言在非 git 上下文打印 WARN 并跳过"), "README 明示安装产物内覆盖率跳过口径");
  const scriptsSection = skill.split("### 全局装机前置与仓库前置条件")[1]?.split("### ")[0] ?? "";
  assert.ok(scriptsSection.includes("~/.omp/agent/skills/mana/scripts/mana-run-lock.py"), "SKILL 前置指向全局 run-lock");
  assert.ok(scriptsSection.includes("~/.omp/agent/skills/mana/scripts/check-mana-grant-scope.py"), "SKILL 前置指向全局 grant guard");
  assert.ok(scriptsSection.includes("MANA_SRC") && scriptsSection.includes("MANA_REPO"), "SKILL 说明源与目标仓环境变量");
  console.log(
    "✓ 装机脚本契约断言通过（真实镜像集/README 表/cmp -s/幂等/不碰配置/四红旗）",
  );
}

function selfTest() {
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  const mappingNeedle = "MIRROR_SOURCES=(skills/mana scripts extensions checks docs README.md AGENTS.md LICENSE)";
  const mappingDrill = script().replace(mappingNeedle, "MIRROR_SOURCES=(skills/mana scripts extensions docs README.md AGENTS.md LICENSE)");
  assert.throws(() => assertMirrorCoverage({ sourceText: mappingDrill, readmeText: readme }));
  console.log("  ✓ 负例(a)：删除 MIRROR_SOURCES 的 checks → 映射覆盖断言实测失败");
  const readmeDrill = readme.replace(/^\| `checks\/\*\*` \|.*$/m, "");
  assert.throws(() => assertMirrorCoverage({ sourceText: script(), readmeText: readmeDrill }));
  console.log("  ✓ 负例(b)：删除 README 的 checks 表行 → README 覆盖断言实测失败");

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
    assert.ok(
      existsSync(join(home, ".omp/agent/skills/mana/SKILL.md")),
      "SKILL.md 直接落在全局 mana skill 根目录",
    );
    assert.ok(
      existsSync(join(home, ".omp/agent/skills/mana/skills/mana/SKILL.md")),
      "正本仓布局保留 skills/mana/SKILL.md",
    );
    assert.ok(
      existsSync(join(home, ".omp/agent/skills/mana/skills/mana/references")),
      "正本仓布局保留 skills/mana/references",
    );
    assert.ok(
      existsSync(join(home, ".omp/agent/skills/mana/references")),
      "技能根 references 单独落位",
    );
    console.log("  ✓ 正本仓布局与技能根落位均存在");
    // (c) 幂等：重跑安装，mtime 不变
    const targets = [
      join(home, ".omp/agent/skills/mana/SKILL.md"),
      join(home, ".pi/agent/extensions/mana-worker.ts"),
      join(home, ".omp/agent/extensions/mana-compact.ts"),
      join(home, ".omp/agent/skills/mana/scripts/mana-preflight.sh"),
      join(home, ".omp/agent/skills/mana/scripts/mana-run-lock.py"),
      join(home, ".omp/agent/skills/mana/scripts/check-mana-grant-scope.py"),
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
    const dryHome = mkdtempSync(join(tmpdir(), "mana-install-dry-"));
    r = run(["--dry-run"], { HOME: dryHome });
    assert.equal(r.code, 1, "未安装的 --dry-run 有漂移则 exit 1");
    assert.ok(r.out.includes(".omp/agent/skills/mana/scripts/mana-preflight.sh"), "--dry-run 列出全局脚本目标");
    r = run(["--dry-run"], env);
    assert.equal(r.code, 0, "已安装的 --dry-run 无漂移则 exit 0");
    rmSync(dryHome, { recursive: true, force: true });
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
    // scripts glob：落位应包含全部源脚本并保留可执行位，新增脚本应进入 --check 清单。
    const scriptsDir = join(home, ".omp/agent/skills/mana/scripts");
    for (const name of ["mana-preflight.sh", "mana-run-lock.py", "check-mana-grant-scope.py"]) {
      assert.ok(existsSync(join(scriptsDir, name)), `${name} 已装机`);
    }
    for (const name of ["mana-preflight.sh", "mana-install.sh", "check-mana-grant-scope.py"]) {
      assert.ok(statSync(join(scriptsDir, name)).mode & 0o111, `${name} 可执行位保留`);
    }
    const scriptProbe = join(REPO, "scripts/install-extra-probe.sh");
    writeFileSync(scriptProbe, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    try {
      r = run(["--check"], env);
      assert.notEqual(r.code, 0, "新增 scripts 文件 → --check 非 0（glob 生效）");
      r = run([], env);
      assert.equal(r.code, 0, "新增 scripts 文件自动安装");
      assert.ok(existsSync(join(scriptsDir, "install-extra-probe.sh")), "新增 scripts 文件已装机");
      assert.ok(statSync(join(scriptsDir, "install-extra-probe.sh")).mode & 0o111, "新脚本可执行位保留");
    } finally {
      rmSync(scriptProbe, { force: true });
      rmSync(join(scriptsDir, "install-extra-probe.sh"), { force: true });
    }
    run([], env);
    r = run(["--check"], env);
    assert.equal(r.code, 0, "删 scripts 探针重装后 --check 回 0");
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
