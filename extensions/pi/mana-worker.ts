/**
 * MANA worker mode（/mana 工人 pi lane）
 *
 * 工人在 herdr pane 内以 `MANA_WORKER=1` 启动（orchestrator: `herdr pane split --env MANA_WORKER=1`）。
 * 该模式下：
 * - 交互式提问类工具在 tool_call 阶段直接 block，并把「按推荐项自行决策」的指令回灌给模型；
 *   pane 里没有人类，任何等待输入的 UI 都是死锁。
 * - `MANA_LANE_ALLOW_PATHS` 非空时，在 write/edit 阶段事前校验目标路径是否落在允许的 glob/前缀内，
 *   越界当场 block 并回灌允许路径清单（0 秒事前纠偏）。
 * - 进程内确定性反射断路器：监听 tool_result，连续 3 次工具报错或重复失败自动在结果追加反射提示
 *   （`REFLEX_PROMPT_INJECTION`），连续 6 次报错触发 `stalled_loop` 断路器阻断后续盲目重试并引导输出 `BLOCKED:`。
 * - 支持将工具与反射事件或会话 JSONL 旁路蒸馏至 `lanes/<lane-id>.events.jsonl`（`MANA_LANE_EVENTS_PATH`）。
 * - 会话启动时 notify 一次，orchestrator 可从 pane 输出确认 env 已生效。
 *
 * 相邻的真实门同样识别 MANA_WORKER：
 * - `safe-guard.ts`：危险 bash 只告警、受保护路径硬阻断（不弹确认）
 * - `precommit-review.ts`：不武装、不排队 `/review`（pi-review 的 select 会卡死 pane）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/** 交互式提问工具名（小写比较）。pi 0.84 无内置提问工具，此表覆盖扩展注册的同名工具。 */
export const INTERACTIVE_TOOLS = ["ask_question", "question", "questionnaire", "askuserquestion", "ask"];

export const MUTATING_FILE_TOOLS = ["write", "edit", "multiedit"];

export const REFLEX_WARN_THRESHOLD = 3;
export const REFLEX_STALL_THRESHOLD = 6;

export const WORKER_ANSWER_INSTRUCTION =
	"MANA 工人模式（MANA_WORKER=1）：交互式提问已禁用，本 pane 没有人类可回答。请自行决策并继续：" +
	"选项带 `recommended` 标记（显示为 “(Recommended)”）就选它，否则选你评估最优的首个选项；" +
	"把该决策写进最终交付的『决策』段。仅当决策超出本 lane 授权范围（tier_grants 的路径/键前缀之外）时，" +
	"才以 `BLOCKED:` 结束，并给出 `QUESTION:` 与 `RECOMMENDED:` 两行。";

export const REFLEX_PROMPT_INJECTION =
	"【MANA 反射监察】检测到连续 3 次工具报错/重复失败; 请立即停止原样重试, 先分析根因或换路径; " +
	"若属环境/授权阻断, 请直接按协议输出 BLOCKED: + QUESTION: + RECOMMENDED:";

export const STALLED_LOOP_INSTRUCTION =
	"【MANA 反射监察 · stalled_loop】检测到连续 6 次工具报错且无进展, 本 lane 已触发断路器 (status=stalled_loop); " +
	"请立即停止重试并按协议输出 BLOCKED: + QUESTION: + RECOMMENDED: 交由编排者走 attempt=2 fresh worker 处置。";

export interface ReflexState {
	consecutiveErrors: number;
	lastFailSig: string;
	sameSigErrors: number;
	stalledLoop: boolean;
}

export function createReflexState(): ReflexState {
	return {
		consecutiveErrors: 0,
		lastFailSig: "",
		sameSigErrors: 0,
		stalledLoop: false,
	};
}

export function isWorkerMode(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.MANA_WORKER === "1";
}

export function decideInteractiveTool(
	toolName: string,
	worker: boolean,
): { block: boolean; reason?: string } {
	if (!worker) return { block: false };
	if (!INTERACTIVE_TOOLS.includes(String(toolName).toLowerCase())) return { block: false };
	return { block: true, reason: WORKER_ANSWER_INSTRUCTION };
}

export function parseAllowPaths(raw?: string): string[] {
	if (!raw) return [];
	return String(raw)
		.split(",")
		.map((s) => s.trim().replace(/^\.\//, ""))
		.filter(Boolean);
}

function globToRegExp(glob: string): RegExp {
	let re = "^";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i++;
			} else {
				re += ".*";
			}
		} else if (c === "?") {
			re += ".";
		} else if ("+()^$.{}[]|\\".includes(c)) {
			re += "\\" + c;
		} else {
			re += c;
		}
	}
	re += "$";
	return new RegExp(re);
}

export function matchesAllowPattern(relPath: string, pattern: string): boolean {
	const cleanRel = relPath.replace(/^\.\//, "");
	const cleanPat = pattern.replace(/^\.\//, "");
	if (!cleanPat) return false;
	if (cleanPat.endsWith("/")) {
		return cleanRel === cleanPat.slice(0, -1) || cleanRel.startsWith(cleanPat);
	}
	if (cleanPat.endsWith("/**")) {
		const prefix = cleanPat.slice(0, -2);
		return cleanRel === cleanPat.slice(0, -3) || cleanRel.startsWith(prefix);
	}
	return globToRegExp(cleanPat).test(cleanRel);
}

export function decideAllowPath(
	toolName: string,
	input: Record<string, unknown> | undefined,
	cwd: string,
	allowRaw = process.env.MANA_LANE_ALLOW_PATHS,
	worker = isWorkerMode(),
): { block: boolean; reason?: string; relPath?: string } {
	if (!worker) return { block: false };
	if (!MUTATING_FILE_TOOLS.includes(String(toolName).toLowerCase())) return { block: false };
	const patterns = parseAllowPaths(allowRaw);
	if (patterns.length === 0) return { block: false };
	const target = String(input?.path ?? input?.file_path ?? "").trim();
	if (!target) return { block: false };

	const baseCwd = cwd || process.cwd();
	const abs = path.resolve(baseCwd, target);
	const rel = path.relative(baseCwd, abs).split(path.sep).join("/");
	const escapesCwd = rel === ".." || rel.startsWith("../") || path.isAbsolute(rel);
	const allowed = !escapesCwd && patterns.some((p) => matchesAllowPattern(rel, p));
	if (allowed) return { block: false, relPath: rel };

	return {
		block: true,
		relPath: rel,
		reason:
			`【MANA 反射监察 · 写路径越界拦截】目标路径 \`${rel}\` 超出本 lane 授权白名单 ` +
			`MANA_LANE_ALLOW_PATHS=[${patterns.join(", ")}]。请仅在授权文件边界内修改；` +
			`若确实需要跨界修改，请立即以 BLOCKED: + QUESTION: + RECOMMENDED: 上报编排者。`,
	};
}

export function normalizeToolSig(toolName: string, input?: Record<string, unknown>): string {
	const t = String(toolName || "").toLowerCase();
	if (t === "bash") {
		const cmd = String(input?.command ?? "").trim().replace(/\s+/g, " ");
		return `bash:${cmd.slice(0, 200)}`;
	}
	if (MUTATING_FILE_TOOLS.includes(t) || t === "read") {
		return `${t}:${String(input?.path ?? input?.file_path ?? "").trim()}`;
	}
	return `${t}:${JSON.stringify(input ?? {}).slice(0, 160)}`;
}

export function recordToolResult(
	state: ReflexState,
	event: { toolName: string; input?: Record<string, unknown>; isError: boolean },
): { action: "none" | "inject_reflex" | "stalled_loop"; message?: string; state: ReflexState } {
	if (!event.isError) {
		state.consecutiveErrors = 0;
		state.sameSigErrors = 0;
		state.lastFailSig = "";
		return { action: "none", state };
	}

	state.consecutiveErrors += 1;
	const sig = normalizeToolSig(event.toolName, event.input);
	if (sig === state.lastFailSig) {
		state.sameSigErrors += 1;
	} else {
		state.lastFailSig = sig;
		state.sameSigErrors = 1;
	}

	if (state.consecutiveErrors >= REFLEX_STALL_THRESHOLD) {
		state.stalledLoop = true;
		return { action: "stalled_loop", message: STALLED_LOOP_INSTRUCTION, state };
	}
	if (state.consecutiveErrors >= REFLEX_WARN_THRESHOLD || state.sameSigErrors >= REFLEX_WARN_THRESHOLD) {
		return { action: "inject_reflex", message: REFLEX_PROMPT_INJECTION, state };
	}
	return { action: "none", state };
}

export function appendLaneEvent(eventsPath: string | undefined, record: Record<string, unknown>): void {
	if (!eventsPath) return;
	try {
		mkdirSync(path.dirname(eventsPath), { recursive: true });
		appendFileSync(
			eventsPath,
			`${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`,
			"utf8",
		);
	} catch {
		// 旁路遥测写盘失败绝不阻断工人主流程
	}
}

/** 旁路蒸馏会话 JSONL 片段为精简事件数组（供写入 lanes/<lane-id>.events.jsonl）。 */
export function distillSessionJsonlChunk(raw: string): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (const line of String(raw || "").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		const etype = String(obj.type ?? "");
		const ts = String(obj.timestamp ?? new Date().toISOString());
		if (etype === "model_change") {
			out.push({ ts, type: "model_change", provider: obj.provider, modelId: obj.modelId });
		} else if (
			["compaction_start", "compaction_end", "auto_retry_start", "auto_retry_end", "extension_error"].includes(etype)
		) {
			out.push({ ts, type: etype });
		} else if (etype === "message" && obj.message && typeof obj.message === "object") {
			const msg = obj.message as Record<string, unknown>;
			const role = String(msg.role ?? "");
			const content = Array.isArray(msg.content) ? msg.content : [];
			const usage = (msg.usage as Record<string, unknown> | undefined) ?? {};
			if (role === "assistant") {
				for (const blk of content) {
					if (!blk || typeof blk !== "object") continue;
					const b = blk as Record<string, unknown>;
					if (b.type === "toolCall") {
						const args = (b.arguments as Record<string, unknown> | undefined) ?? {};
						const arg = String(
							args.command ?? args.path ?? args.pattern ?? args.url ?? JSON.stringify(args),
						)
							.replace(/\s+/g, " ")
							.trim()
							.slice(0, 160);
						out.push({
							ts,
							type: "tool_call",
							tool: String(b.name ?? "?"),
							arg,
							tokens: usage.totalTokens ?? null,
						});
					}
				}
			} else if (role === "toolResult") {
				const isErr = Boolean(msg.isError);
				out.push({
					ts,
					type: "tool_result",
					tool: String(msg.toolName ?? "?"),
					is_error: isErr,
				});
			}
		}
	}
	return out;
}

export default function manaWorker(pi: ExtensionAPI) {
	const worker = isWorkerMode();
	if (!worker) return;

	let announced = false;
	const reflexState = createReflexState();

	pi.on("session_start", (_event, ctx) => {
		if (announced) return;
		announced = true;
		ctx.ui.notify?.("MANA_WORKER=1：交互式提问已禁用，反射监察已启用，提交不触发 pi-review（自主 lane）", "warning");
	});

	pi.on("tool_call", (event, ctx) => {
		const interactiveVerdict = decideInteractiveTool(event.toolName, true);
		if (interactiveVerdict.block) {
			appendLaneEvent(process.env.MANA_LANE_EVENTS_PATH, {
				type: "interactive_blocked",
				tool: event.toolName,
			});
			return { block: true, reason: interactiveVerdict.reason };
		}

		if (
			reflexState.stalledLoop &&
			(event.toolName === "bash" || MUTATING_FILE_TOOLS.includes(String(event.toolName).toLowerCase()))
		) {
			appendLaneEvent(process.env.MANA_LANE_EVENTS_PATH, {
				type: "stalled_loop",
				tool: event.toolName,
				consecutive_errors: reflexState.consecutiveErrors,
			});
			return { block: true, reason: STALLED_LOOP_INSTRUCTION, terminate: true };
		}

		const pathVerdict = decideAllowPath(
			event.toolName,
			event.input as Record<string, unknown> | undefined,
			ctx?.cwd ?? process.cwd(),
			process.env.MANA_LANE_ALLOW_PATHS,
			true,
		);
		if (pathVerdict.block) {
			appendLaneEvent(process.env.MANA_LANE_EVENTS_PATH, {
				type: "allow_path_blocked",
				tool: event.toolName,
				path: pathVerdict.relPath,
				reason: pathVerdict.reason,
			});
			return { block: true, reason: pathVerdict.reason };
		}
	});

	pi.on("tool_result", (event, ctx) => {
		const res = recordToolResult(reflexState, {
			toolName: event.toolName,
			input: event.input,
			isError: Boolean(event.isError),
		});
		appendLaneEvent(process.env.MANA_LANE_EVENTS_PATH, {
			type: "tool_result",
			tool: event.toolName,
			is_error: Boolean(event.isError),
			consecutive_errors: reflexState.consecutiveErrors,
			reflex_action: res.action,
		});
		if (res.action === "none" || !res.message) return;

		if (res.action === "stalled_loop") {
			ctx?.ui?.notify?.("MANA_WORKER=1：连续 6 次工具报错，触发 stalled_loop 断路器", "warning");
		}
		const baseContent = Array.isArray(event.content) ? event.content : [];
		return {
			content: [...baseContent, { type: "text", text: `\n\n${res.message}` }],
			...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
		};
	});
}

// 自检：PI_MANA_WORKER_SELFTEST=1 bun extensions/pi/mana-worker.ts
if (process.env.PI_MANA_WORKER_SELFTEST === "1") {
	const check = (ok: boolean, name: string) => {
		if (!ok) {
			console.error(`FAIL: ${name}`);
			process.exit(1);
		}
		console.log(`ok: ${name}`);
	};
	check(isWorkerMode({ MANA_WORKER: "1" }), "识别 MANA_WORKER=1");
	check(!isWorkerMode({}), "无 env → 非工人模式");
	check(!isWorkerMode({ MANA_WORKER: "0" }), "MANA_WORKER=0 → 非工人模式");
	check(decideInteractiveTool("ask_question", true).block, "工人模式拦截 ask_question");
	check(decideInteractiveTool("Ask_Question", true).block, "大小写不敏感");
	check(!decideInteractiveTool("read", true).block, "普通工具不拦");
	check(!decideInteractiveTool("ask_question", false).block, "非工人模式不拦");
	check(
		decideInteractiveTool("ask_question", true).reason === WORKER_ANSWER_INSTRUCTION,
		"回灌的自决策指令完整",
	);

	// Phase 1: MANA_LANE_ALLOW_PATHS 事前写路径守卫自检
	const cwd = "/worktree/mana";
	const allow = "scripts/,extensions/pi/mana-worker.ts,checks/*.check.mjs";
	check(!decideAllowPath("write", { path: "scripts/echo-discussion-sink.py" }, cwd, allow, true).block, "允许目录前缀内写入");
	check(!decideAllowPath("edit", { path: "extensions/pi/mana-worker.ts" }, cwd, allow, true).block, "允许精确匹配文件编辑");
	check(!decideAllowPath("write", { path: "checks/mana-echo-sink.check.mjs" }, cwd, allow, true).block, "允许 glob 匹配文件写入");
	const blockedOut = decideAllowPath("edit", { path: "README.md" }, cwd, allow, true);
	check(blockedOut.block && Boolean(blockedOut.reason?.includes("MANA_LANE_ALLOW_PATHS")), "越界写入 README.md 被事前拦截");
	check(decideAllowPath("write", { path: "../outside.txt" }, cwd, allow, true).block, "逃逸 worktree 路径被事前拦截");
	check(!decideAllowPath("write", { path: "README.md" }, cwd, "", true).block, "未设 MANA_LANE_ALLOW_PATHS 时不限制");
	check(!decideAllowPath("read", { path: "README.md" }, cwd, allow, true).block, "只读工具不受写路径白名单限制");

	// Phase 1: 连续 3 次报错注入反射提示 & 连续 6 次触发 stalled_loop 断路器
	const rState = createReflexState();
	check(recordToolResult(rState, { toolName: "bash", input: { command: "pytest" }, isError: true }).action === "none", "第 1 次报错不注入");
	check(recordToolResult(rState, { toolName: "bash", input: { command: "pytest" }, isError: true }).action === "none", "第 2 次报错不注入");
	const r3 = recordToolResult(rState, { toolName: "bash", input: { command: "pytest" }, isError: true });
	check(r3.action === "inject_reflex" && r3.message === REFLEX_PROMPT_INJECTION, "连续 3 次报错注入 REFLEX_PROMPT_INJECTION");
	check(recordToolResult(rState, { toolName: "bash", input: { command: "pytest" }, isError: false }).action === "none", "成功后清零连续报错计数");
	check(rState.consecutiveErrors === 0 && rState.sameSigErrors === 0, "成功执行重置计数器");

	for (let i = 1; i <= 5; i++) {
		recordToolResult(rState, { toolName: "bash", input: { command: `fail-${i}` }, isError: true });
	}
	const r6 = recordToolResult(rState, { toolName: "bash", input: { command: "fail-6" }, isError: true });
	check(r6.action === "stalled_loop" && rState.stalledLoop && r6.message === STALLED_LOOP_INSTRUCTION, "连续 6 次报错触发 stalled_loop");

	// Phase 1: 会话 JSONL 旁路蒸馏自检
	const sampleJsonl = [
		JSON.stringify({ type: "model_change", provider: "omniroute", modelId: "omni0free" }),
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				usage: { totalTokens: 512 },
				content: [{ type: "toolCall", name: "bash", arguments: { command: "bun test" } }],
			},
		}),
		JSON.stringify({
			type: "message",
			message: { role: "toolResult", toolName: "bash", isError: true, content: [] },
		}),
	].join("\n");
	const distilled = distillSessionJsonlChunk(sampleJsonl);
	check(distilled.length === 3 && distilled[1].type === "tool_call" && distilled[2].is_error === true, "会话 JSONL 旁路蒸馏提取正确");

	console.log("mana-worker selftest OK");
}
