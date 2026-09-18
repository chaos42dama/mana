/**
 * oh-pi Safe Guard Extension
 *
 * Combines destructive command confirmation + protected paths in one extension.
 *
 * MANA_WORKER=1（herdr 内的 /mana 工人 lane）时改为自主语义：
 * - 危险 bash 命令只发 warning，不弹确认（lane 隔离在 worktree 内，损不掉主干）
 * - 受保护路径直接 block，不再询问——pane 里没有人类，确认框等于死锁
 * - `.pi/` 命中但路径落在当前工作区内（worktree 里的仓库文件，如 .pi/skills/**）不算受保护路径；
 *   只有工作区外的（用户级 ~/.pi/**）才拦
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import path from "node:path";

export const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*-rf\b|.*--force\b)/,
  /\bsudo\s+rm\b/,
  /\b(DROP|TRUNCATE|DELETE\s+FROM)\b/i,
  /\bchmod\s+777\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  />\s*\/dev\/sd[a-z]/,
];

export const PROTECTED_PATHS = [".env", ".git/", "node_modules/", ".pi/", "id_rsa", ".ssh/"];

/** 命中受保护路径的片段，且（对 .pi/ 而言）目标不落在工作区内 */
export function protectedPathHit(target: string, cwd: string): string | undefined {
  const absolute = path.resolve(cwd, target);
  const insideCwd =
    cwd.length > 0 && (absolute === cwd || absolute.startsWith(cwd.endsWith(path.sep) ? cwd : cwd + path.sep));
  return PROTECTED_PATHS.find((p) => {
    if (!target.includes(p) && !absolute.includes(p)) return false;
    if (p === ".pi/" && insideCwd) return false;
    return true;
  });
}

export function isWorkerMode(): boolean {
  return process.env.MANA_WORKER === "1";
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const worker = isWorkerMode();

    // Check bash commands for dangerous patterns
    if (event.toolName === "bash") {
      const cmd = (event.input as { command?: string }).command ?? "";
      const match = DANGEROUS_PATTERNS.find((p) => p.test(cmd));
      if (match && worker) {
        ctx.ui.notify?.(`⚠️ safe-guard 工人模式放行（无人工确认）：${cmd}`, "warning");
      } else if (match && ctx.hasUI) {
        const ok = await ctx.ui.confirm("⚠️ Dangerous Command", `Execute: ${cmd}?`);
        if (!ok) return { block: true, reason: "Blocked by user" };
      }
    }

    // Check write/edit for protected paths
    if (event.toolName === "write" || event.toolName === "edit") {
      const target = (event.input as { path?: string }).path ?? "";
      const hit = protectedPathHit(target, ctx.cwd);
      if (hit) {
        if (worker) return { block: true, reason: `Protected path: ${hit}` };
        if (ctx.hasUI) {
          const ok = await ctx.ui.confirm("🛡️ Protected Path", `Allow write to ${target}?`);
          if (!ok) return { block: true, reason: `Protected path: ${hit}` };
        } else {
          return { block: true, reason: `Protected path: ${hit}` };
        }
      }
    }
  });
}

// 自检：PI_SAFE_GUARD_SELFTEST=1 bun extensions/pi/safe-guard.ts
if (process.env.PI_SAFE_GUARD_SELFTEST === "1") {
  const check = (ok: boolean, name: string) => {
    if (!ok) {
      console.error(`FAIL: ${name}`);
      process.exit(1);
    }
    console.log(`ok: ${name}`);
  };
  const cwd = "/home/dev/worktrees/mana-lane";
  check(protectedPathHit("/home/dev/.pi/agent/extensions/x.ts", cwd) === ".pi/", "工作区外的 .pi/ 仍受保护");
  check(protectedPathHit(".pi/skills/mana/SKILL.md", cwd) === undefined, "工作区内的 .pi/ 不受保护");
  check(protectedPathHit(`${cwd}/.pi/skills/mana/SKILL.md`, cwd) === undefined, "工作区内绝对路径的 .pi/ 不受保护");
  check(protectedPathHit(".env", cwd) === ".env", ".env 仍受保护");
  check(protectedPathHit("/home/dev/.ssh/id_rsa", cwd) === "id_rsa", "工作区外 id_rsa 仍受保护");
  check(protectedPathHit("node_modules/foo.js", cwd) === "node_modules/", "node_modules 仍受保护");
  check(PROTECTED_PATHS.length === 6 && DANGEROUS_PATTERNS.length === 7, "pattern 表未被改小");
  console.log("safe-guard selftest OK");
}
