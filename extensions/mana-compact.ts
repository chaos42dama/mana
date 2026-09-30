/**
 * MANA orchestrator compaction 保真扩展（OMP 编排者侧）
 *
 * 自动压缩会把 run 上下文冲掉——压缩后的会话不记得 state 里的 lane 状态。
 * 本扩展注册 OMP fork 专用事件 "session.compacting"：cwd 下存在 .mana/<run>/state.json
 * 时向压缩摘要注入固定 §0 不变量 + 当前 run 快照 + 下一步；不存在则返回 {}，
 * 不干预非 mana 会话。
 *
 * "session.compacting" 是 OMP fork（@oh-my-pi）专属事件（shared-events.d.ts
 * SessionCompactingEvent/SessionCompactingResult），上游 @mariozechner 类型里没有，
 * 故用下方局部最小结构类型注册，不做全量类型导入。
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readdirSync, readFileSync, statSync, utimesSync } from "node:fs";
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
	// SAFETY: CompactingAPI 是 fork 事件的局部结构类型；handler 只读 cwd 下 state，参数/返回形状由自检与类型证据（shared-events.d.ts 66/316-321）保证。
	(pi as unknown as CompactingAPI).on("session.compacting", () => {
		const cwd = process.cwd();
		const lines = buildManaContext(loadRuns(cwd), cwd);
		return lines.length ? { context: lines } : {};
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
	assert(runs.length === 2, "扫描到两个 run");
	const text = buildManaContext(runs, root).join("\n");
	assert(text.includes("run-new"), "多 run 取最新 mtime 的 run_id");
	assert(!text.includes("run-old"), "不展示旧 run");
	assert(text.includes(resolve(newFile)), "含 state.json 绝对路径");
	assert(text.includes("DONE") && text.includes("BLOCKED"), "含 DONE/BLOCKED 协议关键词");
	assert(text.includes("force-push") && text.includes("双 not_found"), "含 §0 不变量关键词");
	assert(text.includes("lane l1 running extensions/x.ts"), "lane 行 = id status target");
	assert(text.includes("继续监督 sweep"), "有 running → 下一步为监督 sweep");

	const handlers: Array<[string, (e: CompactingEvent) => CompactingResult | void]> = [];
	// SAFETY: 假 pi 只需满足 on() 签名以捕获 handler，不进入运行时路径；真实调用由 fork 加载。
	manaCompact({ on: (n, h) => handlers.push([n, h]) } as unknown as ExtensionAPI);
	assert(handlers.length === 1 && handlers[0][0] === "session.compacting", "注册 session.compacting");
	process.chdir(empty);
	const r1 = handlers[0][1]({ type: "session.compacting", sessionId: "s", messages: [] });
	assert(JSON.stringify(r1) === "{}", "无 .mana → 返回 {} 不干预");
	process.chdir(root);
	const r2 = handlers[0][1]({ type: "session.compacting", sessionId: "s", messages: [] });
	assert(!!r2 && Array.isArray(r2.context) && r2.context.join("\n").includes("run-new"), "有 run → 返回 context 注入");
	process.chdir(startCwd);

	console.log("mana-compact selftest OK");
}
