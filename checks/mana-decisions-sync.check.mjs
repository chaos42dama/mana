#!/usr/bin/env node
// decisions.tsv ↔ state.decision_log 同源契约自检（Issue #108 B 项）
// 无参数：断言 rules 文本——SKILL.md §4 landing 收尾清单有「收尾必跑 mana-sync-decisions.py
//         <run_dir> --check 且 decision_log 与 tsv rows 条数一致」原文、AGENTS.md 规则表已登记本 check、
//         sync 脚本源码含 correction 映射/lanes 非空断言/os.replace 原子写；再对本仓 .mana/
//         真实 run 目录逐个实跑 --check 实盘同源断言（rc=0 ✓ / rc=1 不同源判败 / rc=2 legacy
//         格式 WARN 跳过）；并实跑 `--help` 确认可用。本 check 的实盘审计即 mana-selftest 的
//         同源断言（被 all.check.glob 自动收进，不另加 STEPS 项）。
// --self-test：合成 run 目录 drill——tsv 比 state 多 1 条 → `--check` 非 0 且点名差异条数 →
//         sync → `--check` 归 0 → correction 行映射三字段 → 再跑 sync 幂等（条数不变）→
//         空格分隔坏行判非法 rc=2 → 负例：抹掉脚本 `lanes` 非空断言 / 删 SKILL.md 关键原文
//         → 契约必须失败。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SKILL = join(REPO, "skills/mana/SKILL.md");
const AGENTS = join(REPO, "AGENTS.md");
const SYNC = join(REPO, "scripts/mana-sync-decisions.py");

const TSV_HEADER = "time\tphase\tdecision\treason\tevidence\tresult";

// 一行决策的字段（tsv 行 = 6 个 TAB 分隔字段；state 条目 = 同字段的对象投影）
const fields = (t, phase = "preflight") => [t, phase, `决策${t}`, "r", "e", "ok"];
const rowObj = (t, phase = "preflight") => ({
  time: t,
  phase,
  decision: `决策${t}`,
  reason: "r",
  evidence: "e",
  result: "ok",
});

const writeRun = (dir, tsvRows, logRows) => {
  writeFileSync(join(dir, "decisions.tsv"), TSV_HEADER + "\n" + tsvRows.map((f) => f.join("\t")).join("\n") + "\n");
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({ lanes: [{ id: "lane-b" }], decision_log: logRows }, null, 2),
  );
};

const sync = (runDir, extraArgs = []) =>
  spawnSync("python3", [SYNC, runDir, ...extraArgs], { encoding: "utf8" });

function assertContract(texts = {
  skill: readFileSync(SKILL, "utf8"),
  agents: readFileSync(AGENTS, "utf8"),
  syncSrc: readFileSync(SYNC, "utf8"),
}) {
  // SKILL.md §4 landing 收尾清单：与 mana-run-audit.py 同等地位的必跑项原文
  assert.match(
    texts.skill,
    /收尾锁审计后必跑 `python3 scripts\/mana-sync-decisions\.py <run_dir> --check`，须 `decision_log` 与 `tsv rows` \*\*条数一致\*\*（decisions\.tsv 是决策轨迹权威源，state\.decision_log 只是投影；6 列 tsv 表达不了多行\/额外键，故内容全等不可作为判据——条数不一致即漏写\/多写一条决策）/,
    "SKILL.md §4 收尾清单缺 mana-sync-decisions 必跑原文",
  );
  // AGENTS.md 规则表登记（防 drill 失传）
  assert.match(
    texts.agents,
    /decisions\.tsv 与 state\.decision_log 不同源（两处都可当"全部决策"来读/,
    "AGENTS.md 规则表缺 B 项决策同源行",
  );
  assert.match(
    texts.agents,
    /checks\/mana-decisions-sync\.check\.mjs/,
    "AGENTS.md 规则表缺 mana-decisions-sync.check.mjs 登记行",
  );
  // sync 脚本源码契约：correction 映射 + 写盘前 lanes 非空断言 + os.replace 原子写
  assert.match(texts.syncSrc, /phase == "correction"/, "sync 脚本缺 correction 行映射");
  assert.match(texts.syncSrc, /if not st\.get\("lanes"\)/, "sync 脚本缺 lanes 非空断言");
  assert.match(texts.syncSrc, /os\.replace\(tmp, state_path\)/, "sync 脚本缺 os.replace 原子写");
}

function assertRealRunsWarnOnly() {
  // 本仓 .mana/ 真实 run 目录逐个 --check 审计（审计不判败：历史 run 可能由不同口径落盘）
  // 返回实际审计的 run 数：0 时必须可见 SKIP，否则「契约全绿」是假绿——run #108 实测：
  // herdr worktree 里 .mana/ 是 ignored 目录不存在，本步静默 return，而末行仍宣称实盘断言通过，
  // 导致内容不可满足的判据合入主干后才暴露。依赖 .mana/ 实盘数据的契约必须在正本仓验证。
  const manaDir = join(REPO, ".mana");
  let names = [];
  try {
    names = readdirSync(manaDir);
  } catch {
    console.log("  SKIP：本检出无 .mana/（worktree 内 .mana 被 ignore）→ 实盘同源审计未执行，须在正本仓重跑");
    return 0;
  }
  let audited = 0;
  for (const name of names) {
    const runDir = join(manaDir, name);
    if (!existsSync(join(runDir, "decisions.tsv"))) continue;
    const r = sync(runDir, ["--check"]);
    if (r.status === 0) {
      console.log(`  ✓ .mana/${name} 同源`);
    } else if (r.status === 1) {
      // 可解析 tsv 但与 state 不同源 = 假绿，强断言判败
      assert.fail(`.mana/${name} 决策不同源：${(r.stdout + r.stderr).trim()}`);
    } else {
      // rc=2 = 输入非法：pre-#108 历史 run 的 legacy tsv（如 run-89 空格分隔）由弱口径落盘，
      // 本契约只对 #108 起合规格式的 run 强断言；定位忠实文本断言 + drill 已足够防删改
      console.log(`  WARN：.mana/${name} 非 #108 合规格式（pre-#108 legacy），同源断言跳过`);
    }
    audited += 1;
  }
  return audited;
}

function selfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "mana-decisions-sync-"));
  const runDir = join(scratch, "run-drill");
  mkdirSync(runDir);
  try {
    // ① tsv 比 state 多 1 条 → --check 非 0 且点名差异条数
    writeRun(runDir, [fields("T1"), fields("T2")], [rowObj("T1")]);
    let r = sync(runDir, ["--check"]);
    assert.equal(r.status, 1, `tsv 多于 state 时 --check 必须非 0：${r.stderr}`);
    assert.match(r.stdout, /差异 1 条/, "--check 必须点名差异条数");
    console.log("  ✓ drill：tsv 多 1 条 → --check rc=1 且点名「差异 1 条」");

    // ② sync 后 --check 归 0；无 correction 行时不得出现映射字段
    r = sync(runDir);
    assert.equal(r.status, 0, `sync 应成功：${r.stderr}`);
    r = sync(runDir, ["--check"]);
    assert.equal(r.status, 0, `sync 后 --check 应为 0：${r.stderr}`);
    const st = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    assert.equal(st.decision_log.length, 2);
    assert.deepEqual(
      st.decision_log.filter((x) => x.phase === "correction").map((x) => [x.observed_claim, x.correction, x.source]),
      [],
      "尚无 correction 行，不应有映射字段",
    );
    console.log("  ✓ drill：sync 后 --check rc=0，decision_log 重建为 2 条");

    // ③ correction 行映射（Issue 伪代码：observed_claim=decision / correction=reason / source=evidence）
    const corrFields = ["T3", "correction", "claim-x", "fix-x", "src-x", "fixed"];
    writeRun(runDir, [fields("T1"), fields("T2"), corrFields], st.decision_log);
    r = sync(runDir);
    assert.equal(r.status, 0, `补 correction 行后 sync 应成功：${r.stderr}`);
    const st2 = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    assert.equal(st2.decision_log.length, 3);
    assert.deepEqual(
      st2.decision_log[2],
      {
        time: "T3",
        phase: "correction",
        decision: "claim-x",
        reason: "fix-x",
        evidence: "src-x",
        result: "fixed",
        observed_claim: "claim-x",
        correction: "fix-x",
        source: "src-x",
      },
      "correction 行映射字段不对",
    );
    console.log("  ✓ drill：correction 行映射 observed_claim/correction/source 三字段");

    // ④ 幂等：再跑一次 sync，条数不变、内容不漂移
    const before = readFileSync(join(runDir, "state.json"), "utf8");
    r = sync(runDir);
    assert.equal(r.status, 0);
    assert.equal(readFileSync(join(runDir, "state.json"), "utf8"), before, "sync 幂等：内容不得漂移");
    console.log("  ✓ drill：重复 sync 幂等（条数不变）");

    // ④b 条数相同但内容漂移：--check 不判败（tsv 表达不了多行/额外键），sync 以 tsv 为准且保留额外键
    {
      const drifted = JSON.parse(before);
      drifted.decision_log[0] = { ...drifted.decision_log[0], decision: "旧内容", retry_mode: "network" };
      writeFileSync(join(runDir, "state.json"), JSON.stringify(drifted, null, 2));
      r = sync(runDir, ["--check"]);
      assert.equal(r.status, 0, `条数一致时 --check 不得判败：${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /内容漂移/, "--check 须报出内容漂移行数");
      r = sync(runDir);
      assert.equal(r.status, 0, `同步应成功：${r.stderr}`);
      const after = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
      assert.equal(after.decision_log[0].decision, rowObj("T1").decision, "sync 后内容以 tsv 为准");
      assert.equal(after.decision_log[0].retry_mode, "network", "tsv 表达不了的额外键必须保留");
      console.log("  ✓ drill：条数同内容漂移 → --check rc=0 只报漂移，sync 以 tsv 为准并保留额外键");
    }

    // ⑤ 坏行（空格分隔）判输入非法 rc=2
    writeFileSync(join(runDir, "decisions.tsv"), TSV_HEADER + "\nT4 not a tsv row\n");
    r = sync(runDir, ["--check"]);
    assert.equal(r.status, 2, `坏行必须判非法 rc=2：rc=${r.status}`);
    assert.match(r.stderr, /恰好 6 列/);
    console.log("  ✓ drill：tsv 坏行（列数≠6）→ rc=2 输入非法");

    // ⑥ 负例 a：抹掉 sync 脚本 lanes 非空断言 → 契约必须失败
    const syncSrc = readFileSync(SYNC, "utf8");
    const stripped = syncSrc.replace(/if not st\.get\("lanes"\)[^\n]*\n/, "");
    assert.notEqual(stripped, syncSrc, "负例自检：必须真的删到了 lanes 断言");
    assert.throws(
      () =>
        assertContract({
          skill: readFileSync(SKILL, "utf8"),
          agents: readFileSync(AGENTS, "utf8"),
          syncSrc: stripped,
        }),
      /lanes 非空断言/,
      "删 lanes 非空断言后契约必须失败",
    );
    console.log("  ✗ 负例(a)：抹掉 sync 脚本 lanes 非空断言 → 契约失败");

    // ⑦ 负例 b：删 SKILL.md 关键原文 → 契约断言必须失败
    const skill = readFileSync(SKILL, "utf8");
    const brokenSkill = skill.replace(
      "收尾锁审计后必跑 `python3 scripts/mana-sync-decisions.py <run_dir> --check`，须 `decision_log` 与 `tsv rows` **条数一致**",
      "",
    );
    assert.notEqual(brokenSkill, skill, "负例自检：必须真的删到了 SKILL.md 原文");
    assert.throws(
      () => assertContract({ skill: brokenSkill, agents: readFileSync(AGENTS, "utf8"), syncSrc }),
      /SKILL.md §4 收尾清单缺 mana-sync-decisions 必跑原文/,
      "删 SKILL.md 关键原文后契约断言必须失败",
    );
    console.log("  ✗ 负例(b)：删 SKILL.md 必跑原文 → 契约断言失败");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log("✓ 合成 drill 通过：check 点名差异 / sync 归零 / correction 映射 / 幂等 / rc=2 / 两条负例真失败");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  assertContract();
  const audited = assertRealRunsWarnOnly();
  const h = spawnSync("python3", [SYNC, "--help"], { encoding: "utf8" });
  assert.equal(h.status, 0, `sync 脚本 --help 须可用：${h.stderr}`);
  assert.match(h.stdout, /--check/);
  console.log(
    "✓ decisions 同源契约断言通过（SKILL §4 必跑原文 / AGENTS 登记 / correction 映射 / lanes 断言 / 原子写 / --help 可用）" +
      `+ .mana 实盘同源断言（${audited} 个 run 已审计：legacy WARN 跳过 / 不同源判败）`,
  );
}
