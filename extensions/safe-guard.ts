/**
 * OMP Safe Guard Extension
 * 
 * Combines destructive command confirmation + protected paths in one extension.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*-rf\b|.*--force\b)/,
  /\bsudo\s+rm\b/,
  /\b(DROP|TRUNCATE|DELETE\s+FROM)\b/i,
  /\bchmod\s+777\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  />\s*\/dev\/sd[a-z]/,
];

export const PROTECTED_PATHS = [".env", ".git/", "node_modules/", ".omp/", "id_rsa", ".ssh/"];

/**
 * 自主运行开关（启动时一次性授权，取代逐条人工确认）：
 *   MANA_AUTONOMOUS=1 或 OMP_SAFE_GUARD=off
 * 只跳过 bash 危险命令的确认弹窗（改为 warning 审计通知）；
 * 写入受保护路径的确认与无 UI 时的硬阻断保持不变——密钥/认证类红线不因自主模式放开。
 */
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    // Check bash commands for dangerous patterns
    if (event.toolName === "bash") {
      const cmd = (event.input as { command?: string }).command ?? "";
      const match = DANGEROUS_PATTERNS.find((p) => p.test(cmd));
      const autonomous = process.env.MANA_AUTONOMOUS === "1" || process.env.OMP_SAFE_GUARD === "off";
      if (match && autonomous) {
        ctx.ui.notify?.(`⚠️ safe-guard 自主模式放行（无人工确认）：${cmd}`, "warning");
      } else if (match && ctx.hasUI) {
        const ok = await ctx.ui.confirm("⚠️ Dangerous Command", `Execute: ${cmd}?`);
        if (!ok) return { block: true, reason: "Blocked by user" };
      }
    }

    // Check write/edit for protected paths
    if (event.toolName === "write" || event.toolName === "edit") {
      const path = (event.input as { path?: string }).path ?? "";
      const hit = PROTECTED_PATHS.find((p) => path.includes(p));
      if (hit) {
        if (ctx.hasUI) {
          const ok = await ctx.ui.confirm("🛡️ Protected Path", `Allow write to ${path}?`);
          if (!ok) return { block: true, reason: `Protected path: ${hit}` };
        } else {
          return { block: true, reason: `Protected path: ${hit}` };
        }
      }
    }
  });
}
