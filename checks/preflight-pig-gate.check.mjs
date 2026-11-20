// preflight f 段 pig 门三态断言：临时 PATH / 临时 HOME / 临时 PIG_HOME 构造 pig 在位与否，
// 不依赖本机是否装 pig（真实 pig 目录从 PATH 剔除，门内只看 `command -v pig` 与扩展文件）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportArgs } from "../extensions/pig/herdr-agent-state.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
// Issue #115：暂存目录落 tmpdir() 且按进程隔离（mkdtemp），并发跑互不删 fixture、
// SIGKILL 残留在系统临时目录而非仓库工作树；setupEnv 每次新建子目录保证 HOME/bin 干净。
const SCRATCH = mkdtempSync(join(tmpdir(), "pig-gate-check-"));

function setupEnv() {
  const env = mkdtempSync(join(SCRATCH, "env-"));
  const home = join(env, "home");
  const bin = join(env, "bin");
  for (const d of [
    join(home, ".pi/agent/extensions"),
    join(home, ".omp/agent/extensions"),
    join(home, ".pig/agent/extensions"),
    bin,
  ])
    mkdirSync(d, { recursive: true });

  // c 门：settings.json 给出默认线
  writeFileSync(
    join(home, ".pi/agent/settings.json"),
    JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-x" }),
  );
  // e 门：装机门要求的 6 个扩展拷贝（与 repo 一致 → 无漂移 WARN）
  for (const f of ["mana-worker.ts", "safe-guard.ts", "precommit-review.ts", "mana-worker-compact.ts"])
    cpSync(join(REPO, "extensions/pi", f), join(home, ".pi/agent/extensions", f));
  for (const f of ["mana-compact.ts", "safe-guard.ts"])
    cpSync(join(REPO, "extensions", f), join(home, ".omp/agent/extensions", f));

  // 假二进制：herdr(运行中)/pi(1.0.0, --exclude-tools)/omp(ask.timeout=30)，全 bash 脚本免 node shebang 分支
  const fakes = {
    herdr: '#!/usr/bin/env bash\necho "status: running"\n',
    pi: '#!/usr/bin/env bash\ncase "$1" in --version) echo "pi 1.0.0";; --help) echo "usage: pi [--exclude-tools]";; --list-models) echo "anthropic claude-x";; esac\n',
    omp: '#!/usr/bin/env bash\necho 30\n',
  };
  for (const [name, body] of Object.entries(fakes)) {
    const p = join(bin, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  }
  return { home, bin };
}

// pig 工人侧四扩展（#120）：pig 只从 `$PIG_HOME/agent/extensions` 加载，永不读 `~/.pi`。
// 组3/4 要过 pig 门就必须同时备齐这四份，组4b 故意漏一份证明门会硬失败。
const PIG_WORKERS = ["mana-worker.ts", "mana-worker-compact.ts", "precommit-review.ts", "safe-guard.ts"];
function installPigWorkers(home, { skip = null } = {}) {
  for (const f of PIG_WORKERS) {
    if (f === skip) continue;
    cpSync(join(REPO, "extensions/pi", f), join(home, ".pig/agent/extensions", f));
  }
}

// PATH = 假 bin + 真实 PATH 剔除真实 pig 所在目录（屏蔽本机 pig/herdr；假 herdr 已兜住 a 门）
function buildPath(bin, opts = {}) {
  const realDirs = (process.env.PATH || "").split(":").filter(Boolean);
  let realPigDir = "";
  try {
    realPigDir = dirname(
      spawnSync("bash", ["-c", "command -v pig"], { encoding: "utf8" }).stdout.trim(),
    );
  } catch {}
  const pigBin = join(bin, "pig");
  if (opts.withPig) {
    writeFileSync(pigBin, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(pigBin, 0o755);
  }
  return [bin, ...realDirs.filter((d) => d !== realPigDir && d !== "")].join(":");
}

function runPreflight(bin, home, { withPig = false, env: extraEnv = {} } = {}) {
  // Issue #108：剥离父环境 run 指针（MANA_REPO/MANA_RUN_ID），防泄入合成 env
  // 令预检按真实仓库/run 判门 → 场景① 假红。回归断言见组1b：删掉两个 delete 后其必失败。
  // Issue #117（D1）：MANA_SRC 同理剥离，并显式指向 REPO——宿主 `MANA_SRC=/tmp` 会让预检
  // 源解析门判 /tmp 缺 extensions/pi/mana-worker.ts 而 FAIL，与 mana-preflight-line.check.mjs:127 对齐。
  const {
    MANA_REPO: _leakRepo,
    MANA_RUN_ID: _leakRun,
    MANA_SRC: _leakSrc,
    ...baseEnv
  } = process.env;
  const r = spawnSync("bash", ["scripts/mana-preflight.sh"], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...baseEnv,
      HOME: home,
      MANA_SRC: REPO, // 合成 env 只认本仓正本，不继承宿主的 MANA_SRC
      PATH: buildPath(bin, { withPig }),
      MANA_AUTONOMOUS: "1",
      HERDR_ENV: "1",
      MANA_PREFLIGHT_SKIP_SMOKE: "1", // 只验门逻辑，不真打线路
      ...extraEnv,
    },
  });
  return { rc: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

try {
// 1) pig 未安装（假 bin 无 pig，本机 pig 目录已剔除）→ SKIP 一行，整体 PASS
{
  const { home, bin } = setupEnv();
  const { rc, out } = runPreflight(bin, home);
  assert.equal(rc, 0, `场景① 应 PASS\n${out}`);
  assert.ok(out.includes("pig 门: SKIP pig 未安装"), `场景① 应有 SKIP 行\n${out}`);
  assert.ok(out.includes("PREFLIGHT PASS"), `场景① 应有 PASS 尾行\n${out}`);
  assert.ok(!out.includes("PREFLIGHT FAIL"), `场景① 不应有 FAIL\n${out}`);
  console.log("✓ 组1 pig 未安装 → SKIP，整体 PASS");
}

// 组1b 回归（Issue #108）：父环境带 run 指针（Issue 复现原值；修复后已被剥离，路径是否存在无关）
// 时场景① 仍 PASS——删掉 runPreflight 里两个 delete 后本断言必失败。
{
  process.env.MANA_REPO = "/opt/src/41490/tikoly/nrc";
  process.env.MANA_RUN_ID = "nrc-6-wire";
  try {
    const { home, bin } = setupEnv();
    const { rc, out } = runPreflight(bin, home);
    assert.equal(rc, 0, `父环境带 MANA_REPO+MANA_RUN_ID 时场景① 应 PASS\n${out}`);
    assert.ok(out.includes("PREFLIGHT PASS"), `父环境带指针时场景① 应 PASS 尾行\n${out}`);
    console.log("✓ 组1b 父环境带 MANA_REPO+MANA_RUN_ID → 场景① 仍 PASS（指针不泄入合成 env）");
  } finally {
    delete process.env.MANA_REPO;
    delete process.env.MANA_RUN_ID;
  }
}

// 2) pig 在位但扩展缺失（.pig/agent/extensions 为空）→ FAIL pig 门，整体非 0
{
  const { home, bin } = setupEnv();
  const { rc, out } = runPreflight(bin, home, { withPig: true });
  assert.notEqual(rc, 0, `场景② 应非 0\n${out}`);
  assert.ok(out.includes("PREFLIGHT FAIL: pig 门: 缺"), `场景② 应 FAIL 在 pig 门缺扩展\n${out}`);
  assert.ok(!out.includes("PREFLIGHT PASS"), `场景② 不应 PASS\n${out}`);
  console.log("✓ 组2 pig 在位缺扩展 → FAIL，整体非 0");
}

// 3) pig 在位 + repo 扩展装入临时 HOME 的 .pig（herdr 自报 + 工人四扩展）→ 自检绿，整体 PASS
{
  const { home, bin } = setupEnv();
  cpSync(
    join(REPO, "extensions/pig/herdr-agent-state.ts"),
    join(home, ".pig/agent/extensions/herdr-agent-state.ts"),
  );
  installPigWorkers(home);
  const { rc, out } = runPreflight(bin, home, { withPig: true });
  assert.equal(rc, 0, `场景③ 应 PASS\n${out}`);
  assert.ok(out.includes("pig 门: 工人侧四扩展在位"), `场景③ 应有四扩展 OK 行\n${out}`);
  assert.ok(out.includes("pig 门: herdr-agent-state.ts 在位且 reportArgs 自检绿"), `场景③ 应有 herdr OK 行\n${out}`);
  assert.ok(out.includes("PREFLIGHT PASS"), `场景③ 应有 PASS 尾行\n${out}`);
  console.log("✓ 组3 pig 在位扩展在位 → 自检绿，整体 PASS");
}

// 3b) 工人四扩展漏一份（#120）→ FAIL，整体非 0；且失败原因点名缺的那份。
//     这是修前假绿的复现点：只装 herdr 自报扩展时旧门照报 ok。
{
  const { home, bin } = setupEnv();
  cpSync(
    join(REPO, "extensions/pig/herdr-agent-state.ts"),
    join(home, ".pig/agent/extensions/herdr-agent-state.ts"),
  );
  installPigWorkers(home, { skip: "precommit-review.ts" });
  const { rc, out } = runPreflight(bin, home, { withPig: true });
  assert.notEqual(rc, 0, `场景③b 应非 0\n${out}`);
  assert.ok(
    out.includes("PREFLIGHT FAIL: pig 门: 缺") && out.includes("precommit-review.ts"),
    `场景③b 应点名缺 precommit-review.ts\n${out}`,
  );
  assert.ok(!out.includes("PREFLIGHT PASS"), `场景③b 不应 PASS\n${out}`);
  console.log("✓ 组3b pig 工人四扩展漏一份 → FAIL 且点名缺项（修前假绿的回归断言）");
}

// 4) pig 在位 + 扩展在位但自检失败（假 node exit 1 屏蔽真 node，首目录优先）→ FAIL，整体非 0。
// 注：node 真缺失的 WARN+SKIP 分支无法密闭构造（/usr/bin 不可从 PATH 剔除，其余门依赖它），
// 仅两行 command -v else 分支，留待环境异常时人工验证。
{
  const { home, bin } = setupEnv();
  cpSync(
    join(REPO, "extensions/pig/herdr-agent-state.ts"),
    join(home, ".pig/agent/extensions/herdr-agent-state.ts"),
  );
  installPigWorkers(home);
  const brokenNode = join(bin, "node");
  writeFileSync(brokenNode, "#!/usr/bin/env bash\nexit 1\n");
  chmodSync(brokenNode, 0o755);
  const { rc, out } = runPreflight(bin, home, { withPig: true });
  assert.notEqual(rc, 0, `自检失败应非 0\n${out}`);
  assert.ok(out.includes("PREFLIGHT FAIL: pig 门: 扩展自检 rc="), `应 FAIL 在 pig 门自检\n${out}`);
  console.log("✓ 组4 扩展在位但自检失败（坏 node）→ FAIL，整体非 0");
}

// 5) reportArgs 语义直断（f 段自检同一断言，机器无 pig 也可跑）
{
  const a = reportArgs("idle", { path: "/s.jsonl" });
  assert.ok(a.includes("--source") && a.includes("pig:herdr-state"), "--source 必须为 pig:herdr-state");
  assert.ok(a.includes("--agent-session-path"), "session path 必须携带");
  const b = reportArgs("working");
  assert.ok(
    Number(b[b.indexOf("--seq") + 1]) > Number(a[a.indexOf("--seq") + 1]),
    "--seq 必须严格单调（herdr 丢弃不高于已收序号的报告）",
  );
  console.log("✓ 组5 reportArgs 语义（--source/--agent-session-path/--seq 单调）");
}

} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}
console.log("✓ preflight pig 门校验通过（6 组断言）");
