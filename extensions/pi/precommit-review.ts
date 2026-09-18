/**
 * Pre-commit review gate（配合 pi-review 使用）
 *
 * 拦截 `git commit`，要求本次改动先经过代码审查（/review 由 pi-review 提供）。
 * - 有改动且尚未审查 → 拦截提交，并排队 `/review uncommitted`
 * - 审查结束后重新提交 → 放行；下一次改动会再次武装
 * - 跳过：命令前加 `PI_SKIP_REVIEW=1`
 *
 * MANA_WORKER=1（/mana 工人 lane）时整门关闭：不武装、不拦截、不排队 `/review`。
 * 原因：`/review` 在非空会话里会 `ctx.ui.select("Start review in:", [...])` 并等人工
 * `/end-review`，工人 pane 没有人类 → 死锁。审查由 orchestrator 复验与 PR 评审承担。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COMMIT_RE = /(?:^|[;&|(]\s*)git\s+(?:-C\s+\S+\s+)?commit\b/;
const CHANGES_RE = /(?:^|[;&|(]\s*)git\s+(?:-C\s+\S+\s+)?(?:add|update-index|apply|restore|checkout)\b/;
const BYPASS_RE = /PI_SKIP_REVIEW=1/;
const MUTATING_TOOLS = new Set(["edit", "write", "multiedit", "apply_patch", "str_replace_editor"]);

export function isCommit(command: string): boolean {
	return COMMIT_RE.test(command);
}

export function decideCommit(
	command: string,
	reviewed: boolean,
	worker = process.env.MANA_WORKER === "1",
): { block: boolean; reason?: string } {
	if (worker || !isCommit(command) || BYPASS_RE.test(command) || reviewed) return { block: false };
	return {
		block: true,
		reason:
			"提交被拦截（pre-commit 审查门）：本次改动尚未审查。已排队 `/review uncommitted`，" +
			"请等审查结束、按发现修复后再提交；审查收尾由人工执行 `/end-review`。" +
			"确需跳过本次审查时，把命令改成 `PI_SKIP_REVIEW=1 git commit ...`。",
	};
}

export default function precommitReview(pi: ExtensionAPI) {
	// reviewed=true 表示“当前改动没有待审查内容”；任何改动把它置回 false
	let reviewed = true;
	const worker = process.env.MANA_WORKER === "1";
	let workerNoticeSent = false;

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "bash") {
			const command = String((event.input as { command?: unknown } | undefined)?.command ?? "");
			if (worker && isCommit(command) && !workerNoticeSent) {
				workerNoticeSent = true;
				ctx.ui.notify?.("MANA_WORKER=1：跳过 pre-commit 审查门（审查归 orchestrator/PR）", "warning");
			}
			const verdict = decideCommit(command, reviewed, worker);
			if (verdict.block) {
				reviewed = true; // 只拦一次，避免重复排队
				pi.sendUserMessage("/review uncommitted", {
					deliverAs: "followUp",
					expandPromptTemplates: true,
				});
				return { block: true, reason: verdict.reason };
			}
			if (CHANGES_RE.test(command)) reviewed = false;
			return;
		}
		if (MUTATING_TOOLS.has(event.toolName)) reviewed = false;
	});
}

// 自检：PI_PRECOMMIT_SELFTEST=1 bun extensions/pi/precommit-review.ts
if (process.env.PI_PRECOMMIT_SELFTEST === "1") {
	const check = (ok: boolean, name: string) => {
		if (!ok) {
			console.error(`FAIL: ${name}`);
			process.exit(1);
		}
		console.log(`ok: ${name}`);
	};
	check(isCommit("git commit -m x"), "识别 git commit");
	check(isCommit("cd /repo && git -C /repo commit -F -"), "识别带 -C/前缀的提交");
	check(!isCommit('echo "git commit"'), "不误伤字符串里的 git commit");
	check(decideCommit("git commit -m x", false).block, "未审查 → 拦截");
	check(!decideCommit("git commit -m x", true).block, "已审查 → 放行");
	check(!decideCommit("PI_SKIP_REVIEW=1 git commit -m x", false).block, "跳过标记生效");
	check(!decideCommit("git status", false).block, "非提交命令不拦");
	check(!decideCommit("git commit -m x", false, true).block, "MANA_WORKER=1 → 未审查也不拦");
	check(decideCommit("git commit -m x", false, false).block, "非工人模式仍会拦（回归）");
	check(CHANGES_RE.test("git add -A") && MUTATING_TOOLS.has("edit"), "改动信号可识别");
	console.log("precommit-review selftest OK");
}
