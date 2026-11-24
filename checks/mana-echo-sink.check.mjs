#!/usr/bin/env node
// echo 讨论步进盖楼器与 MANA_ECHO_LIVE=1 门控契约自检（41490/ipi#224 Phase 0）
// 无参数：断言 scripts/echo-discussion-sink.py、scripts/mana-heartbeat.sh、skills/mana/SKILL.md、README.md
//         满足方案 A 粒度（1 run = 1 主帖看板 + Lane 状态跃迁与 decisions.tsv/decision_log 回复楼层 + replyToId）、
//         MANA_ECHO_LIVE=1 线上门控、非阻断降级，并实跑 `--self-test`。
// --self-test：合成 drill——在临时目录演练未设 MANA_ECHO_LIVE 默认 dry-run 落盘 echo-state.json 与
//         lanes/<lane-id>.events.jsonl、重复执行幂等 0 操作、状态跃迁 replyToId 挂接、以及
//         MANA_ECHO_LIVE=1 下假 gh 报错时的非阻断降级（exit 0 + 记录 last_error），附残缺契约负例。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const REQUIRED_SINK_SNIPPETS = [
  'DEFAULT_REPO_ID = "R_kgDOThYpRg"',
  'DEFAULT_ECHO_CATEGORY_ID = "DIC_kwDOThYpRs4DBz3d"',
  'environ.get("MANA_ECHO_LIVE") == "1"',
  "createDiscussion",
  "updateDiscussion",
  "addDiscussionComment",
  "replyToId",
  "distill_session_jsonl",
  "parse_decisions_tsv",
  "safe_sync_mana_run",
  "sync_session",
  "--sync-session",
  "echo-sessions",
  // Issue #128：live 门控 + 字节偏移增量解析 + 单 tick 解析预算
  "MANA_ECHO_TICK_BUDGET_BYTES",
  "MANA_ECHO_MAX_FILE_BYTES",
  "parse_state_path",
  "load_parse_state",
  "save_parse_state",
  "max_bytes",
  // Issue #131：守护 stderr 必须落盘（三处拉起方都用 >/dev/null 2>&1 丢弃，异常不得静默）
  "MANA_ECHO_LOG_DIR",
  "attach_log",
  "dup2",
  // Issue #131：echo 产物清理策略（保留期 + 排除 Discussion 状态）
  "prune_echo_artifacts",
  "PRUNE_RETENTION_DAYS",
  "--prune",
  // Issue #131：dry-run 期留下的假 id 在 live 模式下必须作废（否则每 tick 刷错误日志 / 重复建帖）
  "_is_dryrun_placeholder",
  "MissingNodeError",
  "archived_suppressed",
  // Issue #131：GitHub 侧瞬时故障可重试，且错误日志按根因去重不刷屏
  "_is_transient_error",
  "TransientGraphQLError",
  "log_warn",
  "WARN_DEDUP_WINDOW_SEC",
];

function assertEchoContract({
  sinkText = readFileSync(join(REPO, "scripts/echo-discussion-sink.py"), "utf8"),
  heartbeatText = readFileSync(join(REPO, "scripts/mana-heartbeat.sh"), "utf8"),
  skillText = readFileSync(join(REPO, "skills/mana/SKILL.md"), "utf8"),
  readmeText = readFileSync(join(REPO, "README.md"), "utf8"),
  postmortemText = readFileSync(join(REPO, "scripts/mana-postmortem.sh"), "utf8"),
} = {}) {
  for (const snippet of REQUIRED_SINK_SNIPPETS) {
    assert.ok(
      sinkText.includes(snippet),
      `scripts/echo-discussion-sink.py 缺关键实现片段：${snippet}`,
    );
  }
  assert.ok(
    heartbeatText.includes("echo-discussion-sink.py") &&
      heartbeatText.includes('--sync-mana "$run_dir"'),
    "scripts/mana-heartbeat.sh 须在 sweep_repo 中旁路调用 echo-discussion-sink.py --sync-mana",
  );
  assert.ok(
    heartbeatText.includes("echo-sync-failed"),
    "scripts/mana-heartbeat.sh 须对 echo 同步失败做非阻断日志兜底",
  );
  assert.ok(
    postmortemText.includes("echo-discussion-sink.py") &&
      postmortemText.includes('--sync-mana "$run_dir"'),
    "scripts/mana-postmortem.sh 须在复盘时顺带触发 echo-discussion-sink.py --sync-mana",
  );
  for (const snippet of [
    "echo-discussion-sink.py",
    "MANA_ECHO_LIVE=1",
    "R_kgDOThYpRg",
    "DIC_kwDOThYpRs4DBz3d",
    "replyToId",
    "echo-state.json",
  ]) {
    assert.ok(
      skillText.includes(snippet),
      `skills/mana/SKILL.md 缺 echo 步进盖楼契约说明：${snippet}`,
    );
  }
  assert.ok(
    readmeText.includes("echo-discussion-sink.py") &&
      readmeText.includes("MANA_ECHO_LIVE=1"),
    "README.md 须同步列出 echo-discussion-sink.py 与 MANA_ECHO_LIVE=1",
  );
}

function runPySelfTest() {
  const r = spawnSync(
    "python3",
    [join(REPO, "scripts/echo-discussion-sink.py"), "--self-test"],
    { encoding: "utf8" },
  );
  assert.equal(
    r.status,
    0,
    `echo-discussion-sink.py --self-test 失败：\n${r.stdout}\n${r.stderr}`,
  );
  assert.ok(
    r.stdout.includes("echo-discussion-sink selftest OK"),
    "自检输出须含 selftest OK",
  );
}

function selfTest() {
  // 1) 负例：删掉 MANA_ECHO_LIVE 门控或 heartbeat 挂接必须触发断言失败
  const rawSink = readFileSync(
    join(REPO, "scripts/echo-discussion-sink.py"),
    "utf8",
  );
  assert.throws(
    () =>
      assertEchoContract({
        sinkText: rawSink.replace('environ.get("MANA_ECHO_LIVE") == "1"', ""),
      }),
    /MANA_ECHO_LIVE/,
    "负例 1：移除 MANA_ECHO_LIVE 门控必须失败",
  );
  const rawHb = readFileSync(join(REPO, "scripts/mana-heartbeat.sh"), "utf8");
  assert.throws(
    () =>
      assertEchoContract({
        heartbeatText: rawHb.replace('--sync-mana "$run_dir"', ""),
      }),
    /mana-heartbeat\.sh/,
    "负例 2：移除 mana-heartbeat.sh 的 --sync-mana 挂接必须失败",
  );

  // 1b) Issue #128 负例：移除 live 门控 / 增量解析 / 单 tick 预算必须失败
  for (const [name, snippet, expect] of [
    ["负例 3：移除 live 门控", "MANA_ECHO_TICK_BUDGET_BYTES", /MANA_ECHO_TICK_BUDGET_BYTES/],
    ["负例 4：移除增量解析水位", "save_parse_state", /save_parse_state/],
    ["负例 5：移除单文件上限", "MANA_ECHO_MAX_FILE_BYTES", /MANA_ECHO_MAX_FILE_BYTES/],
    ["负例 6：移除 stderr 落盘", "attach_log", /attach_log/],
    ["负例 7：移除清理策略", "prune_echo_artifacts", /prune_echo_artifacts/],
    ["负例 8：移除 dry-run 假 id 作废", "_is_dryrun_placeholder", /_is_dryrun_placeholder/],
    ["负例 9：移除瞬时故障判定", "_is_transient_error", /_is_transient_error/],
    ["负例 10：移除错误日志去重", "log_warn", /log_warn/],
  ]) {
    assert.throws(
      () =>
        assertEchoContract({
          sinkText: rawSink.replaceAll(snippet, ""),
        }),
      expect,
      `${name} 必须失败`,
    );
  }

  // 2) Live 合成 drill：验证 CLI 默认 dry-run + MANA_ECHO_LIVE=1 断网非阻断降级
  const scratch = mkdtempSync(join(tmpdir(), "mana-echo-sink-drill-"));
  try {
    const runDir = join(scratch, ".mana", "run-224-drill");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "state.json"),
      JSON.stringify({
        run_id: "run-224-drill",
        issue: "41490/ipi#224",
        worker_model: "omniroute/omni0free",
        goal: "验证方案 A 增量盖楼与非阻断降级",
        lanes: [{ id: "lane-1", status: "running", attempt: 1 }],
        decision_log: [],
      }),
    );

    // (a) 未设 MANA_ECHO_LIVE → dry_run: true，写入 echo-state.json
    const envDry = { ...process.env, HOME: scratch };
    delete envDry.MANA_ECHO_LIVE;
    const r1 = spawnSync(
      "python3",
      [join(REPO, "scripts/echo-discussion-sink.py"), "--sync-mana", runDir],
      { env: envDry, encoding: "utf8" },
    );
    assert.equal(r1.status, 0, r1.stderr);
    const out1 = JSON.parse(r1.stdout);
    assert.equal(out1.ok, true);
    assert.equal(out1.dry_run, true, "未设 MANA_ECHO_LIVE 时必须为 dry_run");
    assert.equal(out1.ops.length, 3, "首次同步：建主帖 + lane 顶层楼层 + 刷新主帖");
    assert.ok(existsSync(join(runDir, "echo-state.json")), "echo-state.json 已生成");

    // (b) 设 MANA_ECHO_LIVE=1 但注入失败的假 gh → 仍必须 exit 0 且记录 last_error（绝不阻断主流程）
    const fakeBin = join(scratch, "bin");
    mkdirSync(fakeBin, { recursive: true });
    const fakeGh = join(fakeBin, "gh");
    writeFileSync(
      fakeGh,
      '#!/usr/bin/env bash\necho "secondary rate limit exceeded" >&2\nexit 1\n',
    );
    chmodSync(fakeGh, 0o755);
    const runDirFail = join(scratch, ".mana", "run-224-live-fail");
    mkdirSync(runDirFail, { recursive: true });
    writeFileSync(
      join(runDirFail, "state.json"),
      JSON.stringify({
        run_id: "run-224-live-fail",
        lanes: [{ id: "lane-1", status: "running", attempt: 1 }],
      }),
    );
    const rFail = spawnSync(
      "python3",
      [
        join(REPO, "scripts/echo-discussion-sink.py"),
        "--sync-mana",
        runDirFail,
      ],
      {
        env: {
          ...process.env,
          MANA_ECHO_LIVE: "1",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
      },
    );
    assert.equal(
      rFail.status,
      0,
      "线上 GraphQL 失败时必须 exit 0（非阻断降级）",
    );
    const outFail = JSON.parse(rFail.stdout);
    assert.equal(outFail.ok, false);
    assert.equal(outFail.dry_run, false);
    const savedState = JSON.parse(
      readFileSync(join(runDirFail, "echo-state.json"), "utf8"),
    );
    assert.ok(
      savedState.last_error?.includes("secondary rate limit"),
      "echo-state.json 须记录 last_error 供排查",
    );
    // (c) Session 级反射演练：同一 session 复用同一 Discussion，/new 切换新 session_id 自动新建 Discussion
    const sessA = join(scratch, "2026-10-23T02-25-17-001Z_01a16693-aaaa.jsonl");
    writeFileSync(
      sessA,
      [
        JSON.stringify({ type: "session", id: "01a16693-aaaa", cwd: scratch }),
        JSON.stringify({
          type: "message",
          id: "u1",
          message: { role: "user", content: [{ type: "text", text: "/mana recall #1518" }] },
        }),
      ].join("\n") + "\n",
    );
    const rsA1 = spawnSync(
      "python3",
      [join(REPO, "scripts/echo-discussion-sink.py"), "--sync-session", sessA, "--repo", scratch],
      { env: envDry, encoding: "utf8" },
    );
    assert.equal(rsA1.status, 0, rsA1.stderr);
    const outSA1 = JSON.parse(rsA1.stdout);
    assert.equal(outSA1.ops[0]?.op, "createDiscussion", "首个 session 首次 /mana 指令须创建 Discussion");
    assert.ok(
      existsSync(join(scratch, ".mana", "echo-sessions", "01a16693-aaaa.json")),
      "须生成 .mana/echo-sessions/<session_id>.json",
    );
    const rsA2 = spawnSync(
      "python3",
      [join(REPO, "scripts/echo-discussion-sink.py"), "--sync-session", sessA, "--repo", scratch],
      { env: envDry, encoding: "utf8" },
    );
    assert.equal(JSON.parse(rsA2.stdout).ops.length, 0, "同一 session 无新回合时幂等 0 操作");

    const sessB = join(scratch, "2026-10-23T03-00-00-001Z_01b27700-bbbb.jsonl");
    writeFileSync(
      sessB,
      [
        JSON.stringify({ type: "session", id: "01b27700-bbbb", cwd: scratch }),
        JSON.stringify({
          type: "message",
          id: "u2",
          message: { role: "user", content: [{ type: "text", text: "/mana run #224" }] },
        }),
      ].join("\n") + "\n",
    );
    const rsB1 = spawnSync(
      "python3",
      [join(REPO, "scripts/echo-discussion-sink.py"), "--sync-session", sessB, "--repo", scratch],
      { env: envDry, encoding: "utf8" },
    );
    assert.equal(rsB1.status, 0, rsB1.stderr);
    const outSB1 = JSON.parse(rsB1.stdout);
    assert.equal(outSB1.ops[0]?.op, "createDiscussion", "/new 或重启切换新 session_id 后须创建新 Discussion");
    assert.equal(outSB1.ops[0]?.session_id, "01b27700-bbbb");

    // (d) Issue #128：增量解析——追加回合后再次同步只处理新增字节，仍正确追加楼层
    const sessC = join(scratch, "2026-10-23T04-00-00-001Z_01c00001-cccc.jsonl");
    const sessCBody = [
      JSON.stringify({ type: "session", id: "01c00001-cccc", cwd: scratch }),
      JSON.stringify({
        type: "message",
        id: "v1",
        message: { role: "user", content: [{ type: "text", text: "/mana recall #128" }] },
      }),
    ].join("\n") + "\n";
    writeFileSync(sessC, sessCBody);
    const rsC1 = spawnSync(
      "python3",
      [join(REPO, "scripts/echo-discussion-sink.py"), "--sync-session", sessC, "--repo", scratch],
      { env: envDry, encoding: "utf8" },
    );
    assert.equal(rsC1.status, 0, rsC1.stderr);
    assert.equal(
      JSON.parse(rsC1.stdout).ops[0]?.op,
      "createDiscussion",
      "首次同步须建 Discussion",
    );
    assert.ok(
      existsSync(join(scratch, ".mana", "echo-parse", "01c00001-cccc.json")),
      "须落盘解析水位 .mana/echo-parse/<session_id>.json（增量解析水位）",
    );
    writeFileSync(
      sessC,
      sessCBody +
        JSON.stringify({
          type: "message",
          id: "v2",
          message: { role: "user", content: [{ type: "text", text: "/mana run #128" }] },
        }) +
        "\n",
    );
    const rsC2 = spawnSync(
      "python3",
      [join(REPO, "scripts/echo-discussion-sink.py"), "--sync-session", sessC, "--repo", scratch],
      { env: envDry, encoding: "utf8" },
    );
    assert.equal(rsC2.status, 0, rsC2.stderr);
    const outSC2 = JSON.parse(rsC2.stdout);
    assert.ok(
      outSC2.ops.some((o) => o.op === "addDiscussionComment"),
      "增量解析后追加回合仍须追加楼层",
    );
    assert.ok(
      !outSC2.ops.some((o) => o.op === "createDiscussion"),
      "增量解析不得重复建 Discussion",
    );

    // (e) Issue #128：live 门控——未设 MANA_ECHO_LIVE 时 --watch-repo 必须立即返回（不空转守护）
    const t0 = Date.now();
    const rw = spawnSync(
      "python3",
      [join(REPO, "scripts/echo-discussion-sink.py"), "--watch-repo", scratch],
      { env: envDry, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(rw.status, 0, rw.stderr);
    assert.ok(
      Date.now() - t0 < 5000,
      `live 门控：未设 MANA_ECHO_LIVE 时 --watch-repo 必须立即返回（实测 ${Date.now() - t0}ms）`,
    );

    // (f) Issue #131：stderr 落盘——守护被 >/dev/null 2>&1 拉起时，异常必须进日志文件
    const logDir = join(scratch, "echo-logs");
    const rFail2 = spawnSync(
      "python3",
      [join(REPO, "scripts/echo-discussion-sink.py"), "--sync-mana", join(scratch, "no-such-run")],
      { env: { ...envDry, MANA_ECHO_LOG_DIR: logDir }, encoding: "utf8" },
    );
    assert.equal(rFail2.status, 0, rFail2.stderr);
    assert.equal(rFail2.stderr, "", "stderr 已被接管进日志文件（不应再回吐到调用方）");
    const logFiles = readdirSync(logDir);
    assert.ok(logFiles.length > 0, "须生成 echo 守护日志文件");
    const logText = readFileSync(join(logDir, logFiles[0]), "utf8");
    assert.ok(
      logText.includes("同步失败") && logText.includes("No such file or directory"),
      `日志须记录同步异常（实际内容：${logText.slice(0, 200)}）`,
    );

    // (g) Issue #131：清理策略——过期日志与解析水位被删，Discussion 状态（幂等依据）保留
    const pruneDir = join(scratch, "prune-repo");
    const parseDir = join(pruneDir, ".mana", "echo-parse");
    const sessStateDir = join(pruneDir, ".mana", "echo-sessions");
    mkdirSync(parseDir, { recursive: true });
    mkdirSync(sessStateDir, { recursive: true });
    const stale = Date.now() / 1000 - 30 * 86400;
    for (const [p, isStale] of [
      [join(parseDir, "old.json"), true],
      [join(parseDir, "new.json"), false],
      [join(sessStateDir, "keep.json"), true],
    ]) {
      writeFileSync(p, "{}");
      if (isStale) utimesSync(p, stale, stale);
    }
    const pruneLogs = join(scratch, "prune-logs");
    mkdirSync(pruneLogs, { recursive: true });
    writeFileSync(join(pruneLogs, "old.log"), "x");
    utimesSync(join(pruneLogs, "old.log"), stale, stale);
    const rPrune = spawnSync(
      "python3",
      [
        join(REPO, "scripts/echo-discussion-sink.py"),
        "--prune",
        "--repo",
        pruneDir,
        "--prune-days",
        "14",
      ],
      { env: { ...envDry, MANA_ECHO_LOG_DIR: pruneLogs }, encoding: "utf8" },
    );
    assert.equal(rPrune.status, 0, rPrune.stderr);
    const outPrune = JSON.parse(rPrune.stdout);
    assert.equal(outPrune.ok, true, rPrune.stdout);
    assert.equal(outPrune.pruned.logs, 1, "过期日志须被清理");
    assert.equal(outPrune.pruned.parse_state, 1, "过期解析水位须被清理");
    assert.ok(!existsSync(join(parseDir, "old.json")), "过期解析水位须删除");
    assert.ok(existsSync(join(parseDir, "new.json")), "未过期解析水位须保留");
    assert.ok(
      existsSync(join(sessStateDir, "keep.json")),
      "Discussion 状态（幂等依据）不得被清理——删了会重复建帖",
    );

    // (h) Issue #131：GitHub 侧瞬时故障须可重试（不因单次 5xx 让整轮同步失败）
    const fakeBin2 = join(scratch, "bin2");
    mkdirSync(fakeBin2, { recursive: true });
    const counterFile = join(fakeBin2, "n");
    writeFileSync(
      join(fakeBin2, "gh"),
      [
        "#!/usr/bin/env bash",
        'n=$(cat "$(dirname "$0")/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$(dirname "$0")/n"',
        'if [ "$n" -lt 3 ]; then echo "gh: Something went wrong while executing your query on 2026-11-23T10:19:26Z." >&2; exit 1; fi',
        'echo \'{"data":{"viewer":{"login":"ok"}}\}\'',
      ].join("\n") + "\n",
    );
    chmodSync(join(fakeBin2, "gh"), 0o755);
    const rTransient = spawnSync(
      "python3",
      [
        "-c",
        [
          "import importlib.util, sys",
          `spec = importlib.util.spec_from_file_location("sink", ${JSON.stringify(join(REPO, "scripts", "echo-discussion-sink.py"))})`,
          "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
          'print(m.gh_graphql("query { viewer { login } }", {}, dry_run=False, retries=3, backoff_sec=0.05))',
        ].join("; "),
      ],
      { env: { ...envDry, PATH: `${fakeBin2}:${process.env.PATH ?? ""}` }, encoding: "utf8" },
    );
    assert.equal(rTransient.status, 0, rTransient.stderr);
    assert.ok(
      rTransient.stdout.includes("'login': 'ok'") || rTransient.stdout.includes('"login": "ok"'),
      `瞬时故障重试后应成功（实际输出：${rTransient.stdout.slice(0, 200)}）`,
    );
    assert.ok(
      !existsSync(counterFile) || Number(readFileSync(counterFile, "utf8").trim()) >= 3,
      "须真的重试过（不是一次就过）",
    );

    console.log(
      "✓ 合成 drill 通过：Session 级反射（同 session 复用 / 换 session 新建）+ 默认 dry-run 幂等 + MANA_ECHO_LIVE=1 异常非阻断降级 + 两条负例真失败",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  assertEchoContract();
  runPySelfTest();
  console.log(
    "✓ echo-discussion-sink 契约与自检通过（方案 A 粒度 / MANA_ECHO_LIVE=1 门控 / heartbeat 挂接 / 非阻断降级）",
  );
}
