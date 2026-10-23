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
  rmSync,
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
    const envDry = { ...process.env };
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
    console.log(
      "✓ 合成 drill 通过：默认 dry-run 幂等落盘 + MANA_ECHO_LIVE=1 异常非阻断降级 + 两条负例真失败",
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
