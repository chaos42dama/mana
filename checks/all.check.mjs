#!/usr/bin/env node
// 契约 check 聚合 runner（Issue #57）
// 一条命令跑 checks/ 下全部 *.check.mjs 的两种模式（无参数断言 + --self-test drill），
// 替代 brief/验收里手工枚举 `for f in checks/*.check.mjs; do node "$f"; done` 的回归面
// ——漏列枚举会把「手工枚举」误当「全绿」。
// 只子进程调用既有 check，绝不 import 其内部函数；既有 check 脚本零改动。
// 用法：
//   node checks/all.check.mjs                 # 全部脚本 × 两种模式（2×N 项，不早退）
//   node checks/all.check.mjs --list          # 只列「文件 × 模式」，不执行
//   node checks/all.check.mjs --no-self-test  # 只跑无参数模式
//   node checks/all.check.mjs --only <子串>   # 按文件名子串过滤（单点排查）
//   node checks/all.check.mjs --dir <path>    # 指定检查目录（默认本文件所在目录）；
//                                             # /tmp 副本目录上注入失败断言跑负例，仓库零污染
// 末行输出 ALL-<项数>-rc=<0|1>（沿用 #51 交付惯例 ALL-5-rc=0）；任一项非 0 总码非 0。
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? "");
};
const checksDir = flagValue("--dir") ?? dirname(fileURLToPath(import.meta.url));
const only = flagValue("--only");
const listOnly = argv.includes("--list");
const modes = argv.includes("--no-self-test")
  ? [{ label: "no-args", extraArgs: [] }]
  : [
      { label: "no-args", extraArgs: [] },
      { label: "self-test", extraArgs: ["--self-test"] },
    ];

const files = readdirSync(checksDir)
  .filter((f) => f.endsWith(".check.mjs") && f !== "all.check.mjs") // 绝不执行自己，防递归
  .sort() // 按文件名排序，输出稳定
  .filter((f) => !only || f.includes(only));
if (files.length === 0) {
  console.error(
    `✗ ${checksDir} 下没有匹配的 *.check.mjs${only ? `（--only ${only}）` : ""}`,
  );
  process.exit(1);
}

const items = files.flatMap((file) => modes.map((m) => ({ file, ...m })));
if (listOnly) {
  for (const { file, label } of items) console.log(`${file} × ${label}`);
  process.exit(0);
}

const TIMEOUT_MS = 60_000; // 每项 60s；超时标 ✗ timeout，不挂死
let failed = 0;
for (const { file, label, extraArgs } of items) {
  const name = `${file} × ${label}`;
  const r = spawnSync(process.execPath, [join(checksDir, file), ...extraArgs], {
    timeout: TIMEOUT_MS,
    encoding: "utf8",
  });
  if (r.status === 0) {
    console.log(`✓ ${name}`);
    continue;
  }
  failed++;
  const timedOut = r.signal !== null; // 被 SIGTERM 杀掉 = 超时
  console.log(
    `✗ ${name}${timedOut ? ` timeout (>${TIMEOUT_MS / 1000}s)` : ` exit=${r.status ?? r.signal}`}`,
  );
  // 失败项只带出子进程输出末尾 10 行，整段噪声会淹没摘要
  const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`
    .trimEnd()
    .split("\n")
    .slice(-10);
  for (const line of tail) console.log(`    ${line}`);
}
const rc = failed > 0 ? 1 : 0;
console.log(`ALL-${items.length}-rc=${rc}`);
process.exit(rc);
