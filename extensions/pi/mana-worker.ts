/**
 * MANA worker mode（/mana 工人 pi lane）
 *
 * 工人在 herdr pane 内以 `MANA_WORKER=1` 启动（orchestrator: `herdr pane split --env MANA_WORKER=1`）。
 * 该模式下：
 * - 交互式提问类工具在 tool_call 阶段直接 block，并把「按推荐项自行决策」的指令回灌给模型；
 *   pane 里没有人类，任何等待输入的 UI 都是死锁。
 * - 会话启动时 notify 一次，orchestrator 可从 pane 输出确认 env 已生效。
 *
 * 相邻的真实门同样识别 MANA_WORKER：
 * - `safe-guard.ts`：危险 bash 只告警、受保护路径硬阻断（不弹确认）
 * - `precommit-review.ts`：不武装、不排队 `/review`（pi-review 的 select 会卡死 pane）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 交互式提问工具名（小写比较）。pi 0.84 无内置提问工具，此表覆盖扩展注册的同名工具。 */
export const INTERACTIVE_TOOLS = ["ask_question", "question", "questionnaire", "askuserquestion", "ask"];

export const WORKER_ANSWER_INSTRUCTION =
	"MANA 工人模式（MANA_WORKER=1）：交互式提问已禁用，本 pane 没有人类可回答。请自行决策并继续：" +
	"选项带 `recommended` 标记（显示为 “(Recommended)”）就选它，否则选你评估最优的首个选项；" +
	"把该决策写进最终交付的『决策』段。仅当决策超出本 lane 授权范围（tier_grants 的路径/键前缀之外）时，" +
	"才以 `BLOCKED:` 结束，并给出 `QUESTION:` 与 `RECOMMENDED:` 两行。";

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

export default function manaWorker(pi: ExtensionAPI) {
	const worker = isWorkerMode();
	if (!worker) return;

	let announced = false;

	pi.on("session_start", (_event, ctx) => {
		if (announced) return;
		announced = true;
		ctx.ui.notify?.("MANA_WORKER=1：交互式提问已禁用，提交不触发 pi-review（自主 lane）", "warning");
	});

	pi.on("tool_call", (event) => {
		const verdict = decideInteractiveTool(event.toolName, true);
		if (verdict.block) return { block: true, reason: verdict.reason };
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
	console.log("mana-worker selftest OK");
}
