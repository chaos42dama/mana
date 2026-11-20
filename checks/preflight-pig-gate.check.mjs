// preflight f 段 pig 门三态断言：临时 PATH / 临时 HOME / 临时 PIG_HOME 构造 pig 在位与否，
// 不依赖本机是否装 pig（真实 pig 目录从 PATH 剔除，门内只看 `command -v pig` 与扩展文件）。
// #108：spawnSync 环境显式剥离父环境 MANA_REPO/MANA_RUN_ID（编排者 run pane 里跑本 check 时，
//   真指针泄漏进预检 → 场景①③假默认线对真 run state 误报 drift）；组6 永久回归：本进程 env
//   真实带指针（指向毒化 state）时场景①/③仍须通过，不靠 shell 恰好无变量。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportArgs } from "../extensions/pig/herdr-agent-state.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRATCH = join(REPO, ".tmp-pig-gate-check");
// #108：父环境 run 指针必须剥离，防泄漏进被测预检（真指针 + 假默认线 → 误报 drift）。
const BASE_ENV = { MANA_REPO: undefined, MANA_RUN_ID: undefined };

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
      ...BASE_ENV, // #108：先剥离父环境 run 指针，extraEnv 的显式指针仍生效
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

// 6) 回归（#108）：本进程 env 真实带 run 指针（毒化 state 基线 ≠ 假默认线）时，场景①（无 pig
//    SKIP PASS）与场景③（pig 在位自检绿 PASS）仍须通过——spawnSync 环境剥离失效则此处必现
//    drift FAIL（泄漏 bug 的确定性复现面）。恢复原指针后返回。
{
  const poison = join(SCRATCH, "poison-repo", ".mana", "reg-leak", "state.json");
  mkdirSync(dirname(poison), { recursive: true });
  writeFileSync(poison, JSON.stringify({ worker_model: "openai/gpt-poison" }));
  const saved = { MANA_REPO: process.env.MANA_REPO, MANA_RUN_ID: process.env.MANA_RUN_ID };
  process.env.MANA_REPO = join(SCRATCH, "poison-repo");
  process.env.MANA_RUN_ID = "reg-leak";
  try {
    const s1 = setupEnv();
    const r1 = runPreflight(s1.bin, s1.home);
    assert.equal(r1.rc, 0, `父指针在位时场景① 仍应 PASS（BASE_ENV 剥离失效？）\n${r1.out}`);
    assert.ok(r1.out.includes("PREFLIGHT PASS"), `场景① 不得受父指针影响\n${r1.out}`);
    const s3 = setupEnv();
    cpSync(
      join(REPO, "extensions/pig/herdr-agent-state.ts"),
      join(s3.home, ".pig/agent/extensions/herdr-agent-state.ts"),
    );
    const r3 = runPreflight(s3.bin, s3.home, { withPig: true });
    assert.equal(r3.rc, 0, `父指针在位时场景③ 仍应 PASS\n${r3.out}`);
    assert.ok(r3.out.includes("PREFLIGHT PASS"), `场景③ 不得受父指针影响\n${r3.out}`);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  console.log("✓ 组6 父环境 MANA_REPO/MANA_RUN_ID 泄漏剥离，pig 门场景①/③不受父指针影响");
}

} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}
console.log("✓ preflight pig 门三态校验通过（5 组断言）");
