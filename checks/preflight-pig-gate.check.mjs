// preflight f 段 pig 门三态断言：临时 PATH / 临时 HOME / 临时 PIG_HOME 构造 pig 在位与否，
// 不依赖本机是否装 pig（真实 pig 目录从 PATH 剔除，门内只看 `command -v pig` 与扩展文件）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportArgs } from "../extensions/pig/herdr-agent-state.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRATCH = join(REPO, ".tmp-pig-gate-check");

function setupEnv() {
  rmSync(SCRATCH, { recursive: true, force: true });
  const home = join(SCRATCH, "home");
  const bin = join(SCRATCH, "bin");
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
  const r = spawnSync("bash", ["scripts/mana-preflight.sh"], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
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

// 2) pig 在位但扩展缺失（.pig/agent/extensions 为空）→ FAIL pig 门，整体非 0
{
  const { home, bin } = setupEnv();
  const { rc, out } = runPreflight(bin, home, { withPig: true });
  assert.notEqual(rc, 0, `场景② 应非 0\n${out}`);
  assert.ok(out.includes("PREFLIGHT FAIL: pig 门: 缺"), `场景② 应 FAIL 在 pig 门缺扩展\n${out}`);
  assert.ok(!out.includes("PREFLIGHT PASS"), `场景② 不应 PASS\n${out}`);
  console.log("✓ 组2 pig 在位缺扩展 → FAIL，整体非 0");
}

// 3) pig 在位 + repo 扩展装入临时 HOME 的 .pig → 自检绿，整体 PASS
{
  const { home, bin } = setupEnv();
  cpSync(
    join(REPO, "extensions/pig/herdr-agent-state.ts"),
    join(home, ".pig/agent/extensions/herdr-agent-state.ts"),
  );
  const { rc, out } = runPreflight(bin, home, { withPig: true });
  assert.equal(rc, 0, `场景③ 应 PASS\n${out}`);
  assert.ok(out.includes("pig 门: herdr-agent-state.ts 在位且 reportArgs 自检绿"), `场景③ 应有 OK 行\n${out}`);
  assert.ok(out.includes("PREFLIGHT PASS"), `场景③ 应有 PASS 尾行\n${out}`);
  console.log("✓ 组3 pig 在位扩展在位 → 自检绿，整体 PASS");
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
console.log("✓ preflight pig 门三态校验通过（5 组断言）");
