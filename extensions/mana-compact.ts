/**
 * MANA orchestrator compaction 保真与 Session 级 Echo 反射扩展（OMP 编排者侧）
 *
 * 1. 自动压缩保真：注册 OMP fork 专用事件 "session.compacting"，cwd 下存在 .mana/<run>/state.json
 *    时向压缩摘要注入固定 §0 不变量 + 当前 run 快照 + 下一步；不存在则返回 {}，不干预非 mana 会话。
 * 2. Session 级 Echo 反射（41490/ipi#224）：
 *    - 1 个 Session（`.jsonl` 会话文件，`ctx.sessionManager.getSessionFile()`）= 1 个 `echo` Discussion 主帖；
 *    - 每次 `/new` 新建 session 或 `/q` 退出重启进程生成新的 session 文件后，只要在其中触发 `/mana ...` 指令，
 *      即在 `agent_start` / `agent_end` / `session_switch` 时异步非阻塞触发
 *      `echo-discussion-sink.py --sync-session <session.jsonl>`（并确保持久化 `--watch-repo` 守护在跑），
 *      秒级创建或更新该 Session 专属的 `41490/ipi` `echo` Discussion！
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** fork 侧事件（最小结构）：{type, sessionId, messages} */
interface CompactingEvent {
	type: "session.compacting";
	sessionId: string;
	messages: unknown[];
}
/** fork 侧返回（最小结构）：context 为压缩摘要必含行 */
interface CompactingResult {
	context?: string[];
}
interface CompactingAPI {
	on(event: "session.compacting", handler: (event: CompactingEvent) => CompactingResult | void): void;
	on(event: "session_start" | "session_switch" | "agent_start" | "agent_end", handler: (event: any, ctx?: any) => void): void;
}

export interface ManaLane {
	id?: string;
	status?: string;
	target?: unknown;
}
export interface ManaState {
	run_id?: string;
	lanes?: ManaLane[];
}
export interface RunSnapshot {
	path: string;
	mtimeMs: number;
	state: ManaState;
}

const INVARIANT_SUMMARY =
	"【§0 不变量】state 是唯一事实源；DONE 是 claim 不是 verdict（BLOCKED 后必须紧跟 QUESTION: 与 RECOMMENDED:）；" +
	"代码 lane 必须 worktree+Pi 执行；lane 永不 push/merge（发布权只在 orchestrator）；永不 force-push；" +
	"工人必须回收（agent/pane 双 not_found）；orchestrator 不停在选择上。";

/** 提取会话文件路径（兼容 OMP / Pi 的 ctx.sessionManager.getSessionFile()）。 */
export function resolveSessionFileFromCtx(ctx: any): string | undefined {
	try {
		const f = ctx?.sessionManager?.getSessionFile?.();
		return typeof f === "string" && f.startsWith("/") ? f : undefined;
	} catch {
		return undefined;
	}
}

/** 异步非阻塞触发 Session 级 Echo 反射（绝不阻塞 OMP 主线程，未安装脚本时静默跳过）。 */
export function triggerSessionEchoSync(sessionFile: string | undefined, cwd = process.cwd()): boolean {
	if (!sessionFile || process.env.MANA_COMPACT_SELFTEST === "1" || process.env.MANA_SELFTEST_ACTIVE === "1") {
		return false;
	}
	const sinkScript = join(homedir(), ".omp", "agent", "skills", "mana", "scripts", "echo-discussion-sink.py");
	if (!existsSync(sinkScript)) return false;
	try {
		const child = spawn("python3", [sinkScript, "--sync-session", sessionFile, "--repo", cwd], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		const watcher = spawn("python3", [sinkScript, "--watch-repo", cwd], {
			detached: true,
			stdio: "ignore",
		});
		watcher.unref();
		return true;
	} catch {
		return false;
	}
}

/** IO：扫描 <cwd>/.mana/<run>/state.json（shell glob：.mana + 任意 run 目录），按 mtime 收集可解析的 run 快照。 */
export function loadRuns(cwd: string): RunSnapshot[] {
	const base = join(cwd, ".mana");
	let names: string[];
	try {
		names = readdirSync(base);
	} catch {
		return []; // 无 .mana → 非 mana 会话
	}
	const runs: RunSnapshot[] = [];
	for (const name of names) {
		if (name === "echo-sessions") continue;
		const file = join(base, name, "state.json");
		try {
			const state = JSON.parse(readFileSync(file, "utf8")) as ManaState;
			runs.push({ path: resolve(file), mtimeMs: statSync(file).mtimeMs, state });
		} catch {
			// 单个 run 缺失/损坏不阻塞压缩；state 对账由监督 sweep 负责发现。
		}
	}
	return runs;
}

/** 纯函数：取 mtime 最新 run，产出压缩摘要必含行；无 run 返回 []。 */
export function buildManaContext(runs: RunSnapshot[], _cwd: string): string[] {
	if (!runs.length) return [];
	const latest = runs.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
	const lanes = latest.state.lanes ?? [];
	const lines: string[] = [
		INVARIANT_SUMMARY,
		`run_id: ${latest.state.run_id ?? "(state 缺 run_id)"}`,
		`state: ${latest.path}`,
	];
	for (const lane of lanes) {
		const target = Array.isArray(lane.target) ? lane.target.join(",") : (lane.target ?? "");
		lines.push(`lane ${lane.id ?? "?"} ${lane.status ?? "planned"} ${target}`);
	}
	const statuses = lanes.map((l) => String(l.status ?? "planned"));
	let next: string;
	if (statuses.includes("running") || statuses.includes("verifying")) {
		next = "下一步：有 running/verifying lane → 继续监督 sweep（§3）";
	} else if (lanes.length > 0 && statuses.every((s) => s === "reclaimed")) {
		next = "下一步：全 lane reclaimed → 进入 landing（§4）";
	} else if (statuses.includes("blocked")) {
		next = "下一步：有 blocked lane → 按 blocker 处理（§3.3 自决/上报）";
	} else {
		next = "下一步：无在跑 lane → 重读 state 对账，继续 §3 sweep";
	}
	lines.push(next);
	return lines;
}

export default function manaCompact(pi: ExtensionAPI) {
	const api = pi as unknown as CompactingAPI;
	let currentSessionFile: string | undefined;

	// SAFETY: CompactingAPI 是 fork 事件的局部结构类型；handler 只读 cwd 下 state，参数/返回形状由自检与类型证据（shared-events.d.ts 66/316-321）保证。
	api.on("session.compacting", () => {
		const cwd = process.cwd();
		const lines = buildManaContext(loadRuns(cwd), cwd);
		return lines.length ? { context: lines } : {};
	});

	api.on("session_start", (_event, ctx) => {
		currentSessionFile = resolveSessionFileFromCtx(ctx) ?? currentSessionFile;
	});

	api.on("session_switch", (_event, ctx) => {
		currentSessionFile = resolveSessionFileFromCtx(ctx);
		triggerSessionEchoSync(currentSessionFile, process.cwd());
	});

	api.on("agent_start", (_event, ctx) => {
		currentSessionFile = resolveSessionFileFromCtx(ctx) ?? currentSessionFile;
		triggerSessionEchoSync(currentSessionFile, process.cwd());
	});

	api.on("agent_end", (_event, ctx) => {
		currentSessionFile = resolveSessionFileFromCtx(ctx) ?? currentSessionFile;
		triggerSessionEchoSync(currentSessionFile, process.cwd());
	});
}

// 自检：MANA_COMPACT_SELFTEST=1 bun extensions/mana-compact.ts
if (process.env.MANA_COMPACT_SELFTEST === "1") {
	const assert = (ok: boolean, name: string) => {
		if (!ok) {
			console.error(`FAIL: ${name}`);
			process.exit(1);
		}
		console.log(`ok: ${name}`);
	};
	const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const startCwd = process.cwd();

	const empty = mkdtempSync(join(tmpdir(), "mana-compact-empty-"));
	assert(loadRuns(empty).length === 0, "无 .mana → 扫描为空");
	assert(buildManaContext([], empty).length === 0, "无 run → 空 context");

	const root = mkdtempSync(join(tmpdir(), "mana-compact-run-"));
	const oldFile = join(root, ".mana", "run-old", "state.json");
	const newFile = join(root, ".mana", "run-new", "state.json");
	mkdirSync(join(root, ".mana", "run-old"), { recursive: true });
	mkdirSync(join(root, ".mana", "run-new"), { recursive: true });
	mkdirSync(join(root, ".mana", "echo-sessions"), { recursive: true });
	writeFileSync(oldFile, JSON.stringify({ run_id: "run-old", lanes: [{ id: "l0", status: "reclaimed", target: "a.ts" }] }));
	writeFileSync(newFile, JSON.stringify({
		run_id: "run-new",
		lanes: [
			{ id: "l1", status: "running", target: "extensions/x.ts" },
			{ id: "l2", status: "blocked", target: "README.md" },
		],
	}));
	const oldT = new Date(Date.now() - 60_000);
	const newT = new Date();
	utimesSync(oldFile, oldT, oldT);
	utimesSync(newFile, newT, newT);

	const runs = loadRuns(root);
	assert(runs.length === 2, "扫描到两个 run（自动忽略 echo-sessions 目录）");
	const text = buildManaContext(runs, root).join("\n");
	assert(text.includes("run-new"), "多 run 取最新 mtime 的 run_id");
	assert(!text.includes("run-old"), "不展示旧 run");
	assert(text.includes(resolve(newFile)), "含 state.json 绝对路径");
	assert(text.includes("DONE") && text.includes("BLOCKED"), "含 DONE/BLOCKED 协议关键词");
	assert(text.includes("force-push") && text.includes("双 not_found"), "含 §0 不变量关键词");
	assert(text.includes("lane l1 running extensions/x.ts"), "lane 行 = id status target");
	assert(text.includes("继续监督 sweep"), "有 running → 下一步为监督 sweep");

	assert(
		resolveSessionFileFromCtx({ sessionManager: { getSessionFile: () => "/tmp/s1.jsonl" } }) === "/tmp/s1.jsonl",
		"resolveSessionFileFromCtx 提取绝对路径 session 文件",
	);
	assert(resolveSessionFileFromCtx({}) === undefined, "无 sessionManager → undefined");

	const handlers: Array<[string, (e: any, ctx?: any) => any]> = [];
	// SAFETY: 假 pi 只需满足 on() 签名以捕获 handler，不进入运行时路径；真实调用由 fork 加载。
	manaCompact({ on: (n, h) => handlers.push([n, h]) } as unknown as ExtensionAPI);
	const compactHook = handlers.find(([n]) => n === "session.compacting")?.[1];
	assert(!!compactHook, "注册 session.compacting");
	assert(handlers.some(([n]) => n === "session_switch"), "注册 session_switch 钩子（感知 /new 切换会话）");
	assert(handlers.some(([n]) => n === "agent_start" || n === "agent_end"), "注册 agent_start/end 实时触发钩子");
	process.chdir(empty);
	const r1 = compactHook!({ type: "session.compacting", sessionId: "s", messages: [] });
	assert(JSON.stringify(r1) === "{}", "无 .mana → 返回 {} 不干预");
	process.chdir(root);
	const r2 = compactHook!({ type: "session.compacting", sessionId: "s", messages: [] });
	assert(!!r2 && Array.isArray(r2.context) && r2.context.join("\n").includes("run-new"), "有 run → 返回 context 注入");
	process.chdir(startCwd);

	console.log("mana-compact selftest OK");
}
