/**
 * MANA worker compaction 保真扩展（/mana 工人 pi lane）
 *
 * 工人 lane 上下文接近上限自动压缩时，默认摘要会把原始 brief 冲掉——压缩后
 * 工人不再记得交付边界。本扩展仅在 `MANA_WORKER=1` 下注册 session_before_compact，
 * 整段接管压缩结果：固定工人协议块 + 原始 brief（branchEntries 首条 user 消息）
 * + preparation.previousSummary，保工人不丢契约。
 *
 * 非工人模式不注册、不接管（普通会话用 pi 默认摘要）。
 * 不 import mana-worker.ts：本文件单文件可跑自检，env 自判。
 *
 * 类型证据：dist/core/extensions/types.d.ts 569（SessionBeforeCompactEvent）、
 * 1089（SessionBeforeCompactResult.compaction → CompactionResult）。
 */
import type { ExtensionAPI, SessionBeforeCompactEvent, SessionBeforeCompactResult } from "@earendil-works/pi-coding-agent";

/** brief 截断上限：协议块之外留给原始 brief 的字符数。 */
export const BRIEF_LIMIT = 6000;

export const WORKER_PROTOCOL_BLOCK = [
	"【MANA 工人协议】MANA_WORKER=1 生效中",
	"- 交互提问已禁用：本 pane 没有人类，请自决（有 recommended 项选之，否则选自评最优首项），并把决策写进最终交付的『决策』段",
	"- 最终交付首字符必须是 DONE: 或 BLOCKED:",
	"- BLOCKED: 后必须紧跟两行：QUESTION: 与 RECOMMENDED:",
	"- 禁止 push / PR / merge / 关闭自身 pane（发布与回收只在 orchestrator）",
	"- 禁止 /review 与 /end-review（precommit 审查门已关闭）",
	"- state 是唯一事实源；DONE 是 claim 不是 verdict；超出 tier_grants 授权范围才 BLOCKED",
].join("\n");

export function isWorkerMode(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.MANA_WORKER === "1";
}

/** branchEntries 首条 user 消息文本（string 或 text block 数组），截断至 BRIEF_LIMIT。 */
export function extractBrief(branchEntries: SessionBeforeCompactEvent["branchEntries"]): string {
	for (const entry of branchEntries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "user") continue;
		const text = typeof msg.content === "string"
			? msg.content
			: msg.content
					.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
					.map((b) => b.text)
					.join("\n");
		if (text) return text.length > BRIEF_LIMIT ? `${text.slice(0, BRIEF_LIMIT)}…[brief 截断]` : text;
	}
	return "";
}

/** 纯函数：协议块 + 原始 brief + 上次摘要 → 完整 summary。 */
export function buildSummary(event: SessionBeforeCompactEvent): string {
	const brief = extractBrief(event.branchEntries);
	const previous = event.preparation.previousSummary;
	return [
		WORKER_PROTOCOL_BLOCK,
		"",
		"【原始 brief】",
		brief || "（未找到 user 消息，请向 orchestrator 重投 brief）",
		previous ? `\n【上次压缩摘要】\n${previous}` : "",
	].join("\n");
}

export default function manaWorkerCompact(pi: ExtensionAPI) {
	if (!isWorkerMode()) return;
	pi.on("session_before_compact", (event): SessionBeforeCompactResult => ({
		compaction: {
			summary: buildSummary(event),
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
		},
	}));
}

// 自检：PI_MANA_WORKER_COMPACT_SELFTEST=1 bun extensions/pi/mana-worker-compact.ts
if (process.env.PI_MANA_WORKER_COMPACT_SELFTEST === "1") {
	const check = (ok: boolean, name: string) => {
		if (!ok) {
			console.error(`FAIL: ${name}`);
			process.exit(1);
		}
		console.log(`ok: ${name}`);
	};
	// SAFETY: 自检假 event 只含 buildSummary/接管路径读取的字段（branchEntries、preparation），结构与 SessionBeforeCompactEvent 一致（types.d.ts 569）。
	const fakeEvent = {
		type: "session_before_compact",
		branchEntries: [
			{ type: "message", message: { role: "user", content: "修 extensions/ 下 compaction 保真，验收：两条自检全绿" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "开始" }] } },
		],
		preparation: {
			firstKeptEntryId: "entry-keep-1",
			tokensBefore: 42000,
			previousSummary: "此前已完成 SKILL.md 条款",
			messagesToSummarize: [],
		},
	} as unknown as SessionBeforeCompactEvent;

	check(isWorkerMode({ MANA_WORKER: "1" }), "识别 MANA_WORKER=1");
	check(!isWorkerMode({}), "无 env → 非工人模式");

	const brief = extractBrief(fakeEvent.branchEntries);
	check(brief.includes("compaction 保真"), "提取首条 user 消息 brief");
	check(brief.length <= BRIEF_LIMIT + 20, "brief 受 BRIEF_LIMIT 截断");
	check(extractBrief([]) === "", "无 user 消息 → 空 brief");

	const summary = buildSummary(fakeEvent);
	check(summary.includes("MANA_WORKER=1 生效中"), "summary 含协议块");
	check(summary.includes("DONE:") && summary.includes("BLOCKED:"), "summary 含交付协议关键词");
	check(summary.includes("QUESTION:") && summary.includes("RECOMMENDED:"), "summary 含 BLOCKED 两行");
	check(summary.includes("/review") && summary.includes("push"), "summary 含禁令");
	check(summary.includes("compaction 保真"), "summary 含 brief 片段");
	check(summary.includes("此前已完成 SKILL.md 条款"), "summary 含 previousSummary");

	const handlers: Array<(e: SessionBeforeCompactEvent) => SessionBeforeCompactResult> = [];
	process.env.MANA_WORKER = "1";
	// SAFETY: 假 pi 只需捕获 on() 注册的 handler，不进入真实运行时；handler 行为由下方断言验证。
	manaWorkerCompact({ on: (_n, h) => handlers.push(h) } as unknown as ExtensionAPI);
	check(handlers.length === 1, "工人模式注册 handler");
	const result = handlers[0](fakeEvent);
	check(!!result.compaction, "工人模式返回 compaction 接管");
	check(result.compaction?.firstKeptEntryId === "entry-keep-1", "firstKeptEntryId 沿用 preparation");
	check(result.compaction?.tokensBefore === 42000, "tokensBefore 沿用 preparation");
	check(result.compaction?.summary.includes("compaction 保真"), "接管 summary 含 brief");

	delete process.env.MANA_WORKER;
	const idle: Array<unknown> = [];
	// SAFETY: 同上，假 pi 仅用于断言「非工人模式不注册 handler」。
	manaWorkerCompact({ on: (_n, h) => idle.push(h) } as unknown as ExtensionAPI);
	check(idle.length === 0, "非工人模式不注册、不接管");

	console.log("mana-worker-compact selftest OK");
}
