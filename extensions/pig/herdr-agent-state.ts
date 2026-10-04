// pig -> herdr 状态自报（herdr 官方 pi 集成的 pig 版实现）。
// 装在 ~/.pig/agent/extensions/；pane 内 HERDR_ENV=1 时自动生效。
// 走 `herdr pane report-agent` CLI 而非裸 socket：扩展子进程内直连 socket 对时序敏感
// （见 mana#33 证据 6：官方 pi 集成在 pig 下静默不上报）。
import { execFile, execFileSync } from "node:child_process";

const PANE = process.env.HERDR_PANE_ID;
const BIN = process.env.HERDR_BIN_PATH;
const ENABLED = process.env.HERDR_ENV === "1" && !!PANE && !!BIN;
// herdr 保留 herdr: 前缀给自己的集成，自报集成不得占用。
const SOURCE = "pig:herdr-state";
const AGENT = "pig";

let seq = Date.now() * 1000;
// herdr 丢弃不高于已收序号的报告；跨进程重启也靠 Date.now() 抬过旧值。
const nextSeq = () => (seq = Math.max(seq + 1, Date.now() * 1000));

interface SessionRef {
  path?: string;
}

export function reportArgs(state: string, session?: SessionRef, message?: string): string[] {
  const args = [
    "pane", "report-agent", PANE!,
    "--source", SOURCE,
    "--agent", AGENT,
    "--state", state,
    "--seq", String(nextSeq()),
  ];
  if (session?.path) args.push("--agent-session-path", session.path);
  if (message) args.push("--message", message);
  return args;
}
function releaseArgs(): string[] {
  return ["pane", "release-agent", PANE!, "--source", SOURCE, "--agent", AGENT, "--seq", String(nextSeq())];
}

function sessionPathOf(ctx: unknown): SessionRef {
  if (typeof ctx !== "object" || ctx === null || !("sessionManager" in ctx)) return {};
  const manager: unknown = ctx.sessionManager;
  if (typeof manager !== "object" || manager === null || !("getSessionFile" in manager)) return {};
  const getFile: unknown = manager.getSessionFile;
  if (typeof getFile !== "function") return {};
  const readSessionFile = getFile as (this: unknown) => unknown;
  try {
    const file: unknown = readSessionFile.call(manager);
    return typeof file === "string" && file.startsWith("/") ? { path: file } : {};
  } catch {
    return {};
  }
}

function isBusy(ctx: unknown): boolean {
  if (typeof ctx !== "object" || ctx === null || !("isIdle" in ctx)) return false;
  const isIdle: unknown = ctx.isIdle;
  if (typeof isIdle !== "function") return false;
  const checkIdle = isIdle as (this: unknown) => boolean;
  try {
    return checkIdle.call(ctx) === false;
  } catch {
    return false;
  }
}

function herdr(args: string[]): void {
  execFile(BIN!, args, () => {});
}

interface PiLike {
  on(event: string, handler: (event: unknown, ctx: unknown) => void): void;
}

export default function (pi: PiLike): void {
  if (!ENABLED) return;
  pi.on("session_start", (_event, ctx) => {
    herdr(reportArgs(isBusy(ctx) ? "working" : "idle", sessionPathOf(ctx)));
  });
  pi.on("agent_start", (_event, ctx) => herdr(reportArgs("working", sessionPathOf(ctx))));
  pi.on("agent_settled", (_event, ctx) => herdr(reportArgs("idle", sessionPathOf(ctx))));
  // pig 正常退出（ctrl+d / quit）时释放；herdr 的「回到 shell 提示符自动清理」安全网不认 pig，
  // 被 SIGKILL 时靠 mana 的 pane close 兜底。
  const release = () => {
    try {
      execFileSync(BIN!, releaseArgs(), { stdio: "ignore" });
    } catch (error) {
      // 尽力释放:pane 已退出时 herdr 报错属预期,有意忽略
      void error;
    }
  };
  pi.on("session_shutdown", release);
  process.once("exit", release);
}
