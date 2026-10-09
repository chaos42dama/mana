#!/usr/bin/env node
// scripts/mana-preflight.sh 线路门三态冒烟 + 默认线漂移契约 drill（Issue #73）
// 无参数：临时 HOME + 临时 bin（假 pi/herdr/omp，真实 pi/pig 目录从 PATH 剔除）注入四场景——
//   ① healthy（假 pi -p 应答 OK）→ rc=0，机读行 state=healthy drift=none line=…，PREFLIGHT PASS；
//   ② capacity（假 pi -p 输出 429/quota 文本）→ rc≠0，FAIL 文案 state=capacity（独立容量文案）；
//   ③ unavailable（假 pi -p 输出连接错误文本）→ rc≠0，FAIL 文案 state=unavailable；
//   ④ drift（镜像 repo 造 .mana/<run>/state.json worker_model ≠ settings 默认线）→
//      rc≠0，FAIL 文案含 baseline 与当前值。
//   另断言 settings.json 与 state.worker_model 前后字节不变（预检只读，cmp）。
//   场景①②③跑在真 repo（capacity/unavailable 在 c 段早退、不触 d 段自检门；healthy 走全门，
//   与 pig-gate 组3 同路径）；场景④跑在镜像 repo（drift FAIL 同样 c 段早退）——镜像让 drill
//   不依赖真 repo 是否存在 .mana/（编排者工作区与 fresh worktree 都能跑）。
//   场景①的假 settings 默认线对齐真 repo .mana 的首个 worker_model 基线（无则 anthropic/claude-x），
//   保证 drift=none 断言环境无关。
// --self-test：两条负例（对齐 #55/#65/#68 合成 drill 惯例）——
//   ① 删容量信号集（CAPACITY_RE 换永不匹配词）→ capacity 场景漏判为 unavailable，主断言②失败；
//   ② 删 drift 判定（比较行改恒 none）→ drift 场景不再产生漂移 FAIL，主断言④失败。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRATCH = join(REPO, ".tmp-preflight-line-check");
const FAKE_DEFAULT_LINE = "anthropic/claude-x"; // 镜像场景用的假默认线（与镜像 state 基线不同）
const MIRROR_STATE_LINE = "openai/gpt-old"; // 镜像 .mana state.json 里的旧基线（drift 源）

// 真 repo .mana/*/state.json 的首个非空 worker_model；无则给缺省假线（fresh worktree 形态）
function realBaseLine() {
  try {
    for (const d of readdirSync(join(REPO, ".mana"))) {
      const p = join(REPO, ".mana", d, "state.json");
      if (!existsSync(p)) continue;
      const m = JSON.parse(readFileSync(p, "utf8")).worker_model;
      if (m) return m;
    }
  } catch {}
  return FAKE_DEFAULT_LINE;
}

// 临时 HOME（settings + 装机门六扩展）+ 临时 bin（假 herdr/pi/omp；pi 按 MANA_FAKE_SMOKE 演绎三态输出）
function setupEnv(line) {
  rmSync(SCRATCH, { recursive: true, force: true });
  const home = join(SCRATCH, "home");
  const bin = join(SCRATCH, "bin");
  for (const d of [
    join(home, ".pi/agent/extensions"),
    join(home, ".omp/agent/extensions"),
    bin,
  ])
    mkdirSync(d, { recursive: true });

  const [prov, model] = line.split("/");
  writeFileSync(
    join(home, ".pi/agent/settings.json"),
    JSON.stringify({ defaultProvider: prov, defaultModel: model }),
  );
  for (const f of ["mana-worker.ts", "safe-guard.ts", "precommit-review.ts", "mana-worker-compact.ts"])
    cpSync(join(REPO, "extensions/pi", f), join(home, ".pi/agent/extensions", f));
  for (const f of ["mana-compact.ts", "safe-guard.ts"])
    cpSync(join(REPO, "extensions", f), join(home, ".omp/agent/extensions", f));

  const fakes = {
    herdr: '#!/usr/bin/env bash\necho "status: running"\n',
    // -p 分支按 MANA_FAKE_SMOKE 演绎：capacity/unavailable 输出对应信号文本且非 0，默认应答 OK
    pi: [
      "#!/usr/bin/env bash",
      'case "$1" in',
      '  --version) echo "pi 1.0.0";;',
      '  --help) echo "usage: pi [--exclude-tools]";;',
      '  --list-models) echo "${MANA_FAKE_LINE}";;',
      "  -p)",
      '    case "${MANA_FAKE_SMOKE:-healthy}" in',
      '      capacity) echo "Error: 429 rate limit exceeded (quota exhausted, 余额不足)"; exit 1;;',
      '      unavailable) echo "connect ECONNREFUSED api.example.com:443"; exit 1;;',
      '      *) echo "OK"; exit 0;;',
      "    esac;;",
      "esac",
    ].join("\n"),
    omp: '#!/usr/bin/env bash\necho 30\n',
  };
  for (const [name, body] of Object.entries(fakes)) {
    const p = join(bin, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  }
  return { home, bin, line };
}

// PATH = 临时 bin 优先；剔除真 PATH 上 pig 所在目录（防本机真 pig 触发 pig 门）
function buildPath(bin) {
  const realDirs = (process.env.PATH || "").split(":");
  let realPigDir = "";
  try {
    realPigDir = dirname(
      spawnSync("bash", ["-c", "command -v pig || true"], { encoding: "utf8" }).stdout.trim(),
    );
  } catch {}
  return [bin, ...realDirs.filter((d) => d !== realPigDir && d !== "")].join(":");
}

function runPreflight(bin, home, { cwd = REPO, line = FAKE_DEFAULT_LINE, env: extraEnv = {} } = {}) {
  const r = spawnSync("bash", [join(cwd, "scripts/mana-preflight.sh")], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: buildPath(bin),
      MANA_AUTONOMOUS: "1",
      HERDR_ENV: "1",
      MANA_FAKE_LINE: line, // 假 pi --list-models 输出该线，对齐假 settings 默认线
      // 防反向环：本 check 被 all.check 跑时，预检 d 门 selftest 会再跑 all.check → 又调回本 check，
      // 内层 rmSync 会删掉外层 SCRATCH（HOME）→ 装机门假 FAIL。注入嵌套标记让 mana-selftest.sh
      // SKIP contracts（其内置切断语义，见该文件头注释；pig-gate 经 SKIP_SMOKE 侧同一机制切断）。
      MANA_SELFTEST_ACTIVE: "1",
      ...extraEnv,
    },
  });
  return { rc: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

// 镜像 repo：只放被测脚本（+ 可选 drift 基线 state.json）；drift/篡改场景在此跑，c 段 FAIL 早退
function makeMirror({ stateLine = null, tamper = null } = {}) {
  const mirror = join(SCRATCH, "repo");
  mkdirSync(join(mirror, "scripts"), { recursive: true });
  let src = readFileSync(join(REPO, "scripts/mana-preflight.sh"), "utf8");
  if (tamper) {
    src = tamper(src);
    assert.notEqual(src, readFileSync(join(REPO, "scripts/mana-preflight.sh"), "utf8"), "篡改必须生效");
  }
  writeFileSync(join(mirror, "scripts/mana-preflight.sh"), src);
  if (stateLine) {
    const runDir = join(mirror, ".mana/run-drill");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "state.json"), JSON.stringify({ worker_model: stateLine }));
  }
  return mirror;
}

try {
  // 1) healthy：假 pi 应答 OK → 全门过 rc=0，机读行 state=healthy drift=none；settings 字节不变
  {
    const line = realBaseLine();
    const { home, bin } = setupEnv(line);
    const before = readFileSync(join(home, ".pi/agent/settings.json"));
    const { rc, out } = runPreflight(bin, home, { line });
    assert.equal(rc, 0, `场景① 应 PASS\n${out}`);
    assert.ok(out.includes(`线路门: state=healthy drift=none line=${line}`), `场景① 应有机读行\n${out}`);
    assert.ok(out.includes("PREFLIGHT PASS"), `场景① 应有 PASS 尾行\n${out}`);
    assert.ok(!out.includes("PREFLIGHT FAIL"), `场景① 不应有 FAIL\n${out}`);
    assert.ok(before.equals(readFileSync(join(home, ".pi/agent/settings.json"))), "场景① settings.json 必须字节不变（预检只读）");
    console.log("✓ 组1 healthy → rc=0，state=healthy drift=none，settings 只读未变");
  }

  // 2) capacity：429/quota 文本 → FAIL 独立容量文案，非 0，不误判 unavailable
  {
    const { home, bin } = setupEnv(realBaseLine());
    const { rc, out } = runPreflight(bin, home, { env: { MANA_FAKE_SMOKE: "capacity" } });
    assert.notEqual(rc, 0, `场景② 应 FAIL\n${out}`);
    assert.ok(out.includes("PREFLIGHT FAIL: 线路门: 冒烟 state=capacity"), `场景② 应有 capacity 独立文案\n${out}`);
    assert.ok(!out.includes("state=unavailable"), `场景② 不得误判 unavailable\n${out}`);
    console.log("✓ 组2 capacity → FAIL 独立容量文案，整体非 0");
  }

  // 3) unavailable：连接错误文本 → FAIL 兜底文案，非 0
  {
    const { home, bin } = setupEnv(realBaseLine());
    const { rc, out } = runPreflight(bin, home, { env: { MANA_FAKE_SMOKE: "unavailable" } });
    assert.notEqual(rc, 0, `场景③ 应 FAIL\n${out}`);
    assert.ok(out.includes("PREFLIGHT FAIL: 线路门: 冒烟 state=unavailable"), `场景③ 应有 unavailable 文案\n${out}`);
    assert.ok(!out.includes("state=capacity"), `场景③ 不得误判 capacity\n${out}`);
    console.log("✓ 组3 unavailable → FAIL 兜底文案，整体非 0");
  }

  // 4) drift：镜像 repo 造 state 基线 ≠ settings 默认线（冒烟 healthy）→ drift FAIL 列 baseline/当前值；
  //    state.worker_model 字节不变
  {
    const { home, bin } = setupEnv(FAKE_DEFAULT_LINE);
    const mirror = makeMirror({ stateLine: MIRROR_STATE_LINE });
    const statePath = join(mirror, ".mana/run-drill/state.json");
    const before = readFileSync(statePath);
    const { rc, out } = runPreflight(bin, home, { cwd: mirror });
    assert.notEqual(rc, 0, `场景④ 应 FAIL\n${out}`);
    assert.ok(
      out.includes(`默认线漂移 drift（baseline=${MIRROR_STATE_LINE} 当前=${FAKE_DEFAULT_LINE}`),
      `场景④ 应有漂移文案含 baseline/当前\n${out}`,
    );
    assert.ok(before.equals(readFileSync(statePath)), "场景④ state.worker_model 必须字节不变（预检只读）");
    console.log("✓ 组4 drift → FAIL 列 baseline/当前值，state 只读未变");
  }
  console.log("✓ preflight 线路门三态+drift 校验通过（4 组断言）");

  if (process.argv.includes("--self-test")) {
    // 负例①：删容量信号集（CAPACITY_RE 换永不匹配词）→ capacity 场景漏判为 unavailable（主断言②失败）
    {
      const { home, bin } = setupEnv(realBaseLine());
      const mirror = makeMirror({
        tamper: (s) => s.replace(/^CAPACITY_RE=.*$/m, "CAPACITY_RE='ZZZ_NEVER_MATCH'"),
      });
      const { rc, out } = runPreflight(bin, home, { cwd: mirror, env: { MANA_FAKE_SMOKE: "capacity" } });
      assert.ok(!out.includes("state=capacity"), "负例① 删容量信号后不得再判 capacity");
      assert.ok(out.includes("state=unavailable"), `负例① capacity 应漏判为 unavailable\n${out}`);
      assert.notEqual(rc, 0);
      console.log("  ✗ 删容量信号失败：CAPACITY_RE 换死词 → capacity 漏判 unavailable，主断言②必失败（负例证据）");
    }
    // 负例②：删 drift 判定（比较行恒不触发）→ drift 场景不再产生漂移 FAIL（主断言④失败）
    {
      const { home, bin } = setupEnv(FAKE_DEFAULT_LINE);
      const mirror = makeMirror({
        stateLine: MIRROR_STATE_LINE,
        tamper: (s) => s.replace('[ "$M" = "$WORKER_MODEL" ] || DRIFT_STATE="drift"', "DRIFT_STATE=none"),
      });
      const { out } = runPreflight(bin, home, { cwd: mirror });
      assert.ok(!out.includes("默认线漂移"), "负例② 删 drift 判定后不得再有漂移 FAIL 文案");
      console.log("  ✗ 删 drift 判定失败：比较行恒 none → 漂移 FAIL 消失，主断言④必失败（负例证据）");
    }
    console.log("✓ 合成 drill 通过：删容量信号失败；删 drift 判定失败");
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}
