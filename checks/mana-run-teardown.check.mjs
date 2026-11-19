#!/usr/bin/env node
// run 收尾锁审计契约自检（首次发现：nrc run #3 的 fifo 孤儿持锁 shell）
// 无参数：断言 rules 文本——SKILL.md 持锁入口禁止 fifo/管道喂命令且注明 fd 继承导致永不 EOF、
//         §4 landing 收尾必跑 mana-run-audit.py 且明说 pgrep 假阴性；README 关键脚本列该工具；
//         AGENTS.md 对照表登记本 check。
// --self-test：真进程 drill——用 mana-run-lock.py 起一个「读 fifo 且自己继承写端」的孤儿，
//         断言 (a) 按脚本名 pgrep/扫 cmdline 假阴性、(b) 审计判 DIRTY 并点名持锁 pid 与
//         fifo-stdin 死锁签名、(c) `--expect held` 对 fifo-stdin 持有者也判 DIRTY、
//         终止后转 CLEAN、(d) 删任一关键原文后契约断言必须失败。
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SKILL = join(REPO, "skills/mana/SKILL.md");
const AUDIT = join(REPO, "scripts/mana-run-audit.py");
const LOCK = join(REPO, "scripts/mana-run-lock.py");

const REQUIRED = [
  {
    name: "持锁入口禁止 fifo/管道",
    file: SKILL,
    snippets: [
      "禁止 `mkfifo` + 管道喂命令建持锁会话",
      "read` 不返回 EOF",
      "继承了写端 fd",
    ],
  },
  {
    name: "收尾必跑锁审计且 pgrep 不足以判定",
    file: SKILL,
    snippets: [
      "mana-run-audit.py <run_dir>",
      "`pgrep -af 'mana-run-lock",
      "假阴性",
      "`--expect held`",
    ],
  },
  {
    name: "README 关键脚本与 AGENTS 对照表",
    file: join(REPO, "README.md"),
    snippets: ["scripts/mana-run-audit.py"],
  },
];

function readAll() {
  return {
    [SKILL]: readFileSync(SKILL, "utf8"),
    [join(REPO, "README.md")]: readFileSync(join(REPO, "README.md"), "utf8"),
    [join(REPO, "AGENTS.md")]: readFileSync(join(REPO, "AGENTS.md"), "utf8"),
  };
}

function assertContract(texts = readAll()) {
  for (const group of REQUIRED) {
    const text = texts[group.file];
    for (const snippet of group.snippets) {
      assert.ok(
        text.includes(snippet),
        `缺关键原文【${group.name}】：\n  「${snippet}」\n  请核对 ${group.file} 该句是否被删改（按内容匹配，不按行号）`,
      );
    }
  }
  assert.ok(
    texts[join(REPO, "AGENTS.md")].includes("checks/mana-run-teardown.check.mjs"),
    "AGENTS.md 对照表须登记本 check（防 drill 失传）",
  );
  // 工具自身必须在位且可自述用法
  const help = execFileSync("python3", [AUDIT, "--help"], { encoding: "utf8" });
  assert.ok(help.includes("--expect"), "mana-run-audit.py --help 须含 --expect");
}

function sleep(ms) {
  return Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function audit(runDir, extra = []) {
  try {
    const out = execFileSync("python3", [AUDIT, runDir, "--json", ...extra], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, report: JSON.parse(out) };
  } catch (error) {
    assert.equal(typeof error.status, "number", `审计应正常退出而非崩溃：${error.message}`);
    return { code: error.status, report: JSON.parse(error.stdout || "{}") };
  }
}

function scanCmdline(needle) {
  // 复刻 run #3 §3 建议的判据：按脚本名/路径匹配进程 cmdline。
  // needle 必须限定到本 drill 的 run_dir——否则并发的另一次 drill 会让断言假红。
  const hits = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8").replace(/\0/g, " ");
      if (cmdline.includes(needle)) hits.push({ pid: entry, cmdline });
    } catch {
      /* 进程已消失或无权限 */
    }
  }
  return hits;
}

function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    sleep(50);
  }
  assert.fail(`等待超时：${label}`);
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "mana-teardown-"));
  const runDir = join(dir, "run");
  mkdirSync(runDir);
  const fifo = join(runDir, "orch.fifo");
  execFileSync("mkfifo", [fifo]);

  // 孤儿形态照抄 run #3：nohup + fifo 喂命令；读端的写端由自身 `exec 7<>` 继承 ⇒ 永不 EOF
  const orphanCode = `exec 7<>${fifo}; while IFS= read -r l; do eval "$l"; done < ${fifo}`;
  const child = spawn(
    "python3",
    [LOCK, runDir, "drill-orphan", "--", "/bin/bash", "--noprofile", "--norc", "-c", orphanCode],
    { detached: true, stdio: "ignore" },
  );
  const cleanup = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    waitFor(() => {
      try {
        return audit(runDir, ["--expect", "held"]).report?.flock_free === false;
      } catch {
        return false;
      }
    }, "孤儿取得锁");

    // (a) 按脚本名的判据假阴性：launcher 已 exec 成 bash，cmdline 无 mana-run-lock
    const byName = scanCmdline("mana-run-lock").filter((h) => h.cmdline.includes(runDir));
    assert.deepEqual(byName, [], "按 mana-run-lock 名匹配 cmdline 必须假阴性（run #3 实测）");
    // 但按 run_dir 匹配能看见进程本身 —— 证明它确实活着，只是名字不对
    assert.ok(
      scanCmdline(runDir).length >= 1,
      "按 run_dir 匹配必须能看到持锁进程（证明孤儿存活）",
    );
    console.log("  ✓ 负例(a)：按脚本名扫 cmdline → 0 命中，而按 run_dir 扫可见进程（pgrep 判据假阴性）");

    // (b) 审计按锁 inode 取证，必须 DIRTY 并点名持锁 pid
    const dirty = audit(runDir);
    assert.equal(dirty.code, 1, "孤儿持锁时 --expect free 必须退出 1");
    assert.equal(dirty.report.clean, false, "孤儿持锁时 clean=false");
    assert.equal(dirty.report.flock_free, false, "flock 必须判 HELD");
    assert.ok(dirty.report.holders.length >= 1, "必须点名至少一个持锁进程");
    assert.ok(
      dirty.report.holders.some((h) => h.stdin_fifo),
      "持锁进程必须被标出 stdin 是命名 fifo（永不 EOF 的成因）",
    );
    assert.ok(
      dirty.report.fifo_files.includes("orch.fifo"),
      "run 目录内的 fifo 必须作为线索被点名（禁止 fifo 喂命令的可观测痕迹）",
    );
    console.log(
      `  ✓ 正例(b)：审计 DIRTY，持锁 pid=${dirty.report.holders.map((h) => h.pid).join(",")}，fifo=${dirty.report.fifo_files.join(",")}`,
    );

    // (c) 清理后必须转 CLEAN；且 --expect held 时 fifo-stdin 的持有者必须判 DIRTY
    const fifoHeld = audit(runDir, ["--expect", "held"]);
    assert.equal(
      fifoHeld.code,
      1,
      "持有者 stdin 是 fifo 时 --expect held 也必须 DIRTY（死锁签名，不是健康的 run 进行中）",
    );
    assert.deepEqual(
      fifoHeld.report.detached_stdin_holders,
      [dirty.report.holders[0].pid],
      "detached_stdin_holders 必须点名 stdin 为 fifo 的持锁 pid",
    );
    process.kill(-child.pid, "SIGTERM");
    child.unref();
    waitFor(() => audit(runDir).code === 0, "终止孤儿后审计转 CLEAN");
    const clean = audit(runDir);
    assert.equal(clean.report.flock_free, true, "清理后 flock 必须 FREE");
    assert.deepEqual(clean.report.holders, [], "清理后不得残留持锁进程");
    console.log("  ✓ 正例(c)：fifo-stdin 持有者判 DIRTY→终止后 CLEAN（flock FREE / 无 holder）");
  } finally {
    cleanup();
  }

  // (d) 负例：删任一关键原文（该原文的全部出现）→ 契约断言必须失败
  const texts = readAll();
  for (const group of REQUIRED) {
    const broken = {
      ...texts,
      [group.file]: texts[group.file].split(group.snippets[0]).join(""),
    };
    assert.throws(
      () => assertContract(broken),
      (err) => err.message.includes(group.snippets[0].slice(0, 20)),
      `删「${group.snippets[0]}」后契约断言必须失败`,
    );
    console.log(`  ✗ 负例(d)：删【${group.name}】关键原文 → 检查失败`);
  }

  console.log("✓ 合成 drill 通过：pgrep 假阴性 / 审计 DIRTY 点名 / 清理转 CLEAN / 删原文必败");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  assertContract();
  console.log("✓ SKILL/README/AGENTS 锁收尾契约断言通过（禁 fifo 持锁会话 / 收尾必跑审计 / pgrep 假阴性）");
}
