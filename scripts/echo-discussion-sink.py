#!/usr/bin/env python3
"""echo-discussion-sink.py — 将 mana 的执行过程、Session 回合、Lane 状态跃迁与反射监察事件
映射为 GitHub Discussions (41490/ipi · categories/echo) 的讨论帖与分步回复（Session 级 + 方案 A 粒度）。

核心模型 (Session-based Echo Reflection):
1. **1 个 Session = 1 个 Discussion 主帖**:
   - 每次用户在 `omp`/`pi` 中执行 `/new` 新建会话或 `/q` 退出后重启进程，都会生成新的会话 `.jsonl` 文件 (`session_id`)；
   - 当在该 session 中触发任何 `/mana` 相关指令（如 `/mana recall`、`/mana how`、`/mana why`、`/mana architect`、`/mana veri`、`/mana run` 等）时，
     自动为该 `session_id` 创建（或复用）专属的 `41490/ipi` `echo` Discussion 主帖；
   - 同一 `session_id` 内的 `/mana` 指令回合（`[session:turn]` + 折叠工具轨迹 + 回复摘要）以及该 session 所调度的 `.mana/<run-id>/`
     Lane 状态跃迁 (`planned -> running -> verified/blocked/reclaimed`) 与 `decisions.tsv` / `decision_log` 事件，
     全部汇总盖楼到这同一个 Session 的 Discussion 下；
   - 一旦 `/new` 或重启进程切换了 `session_id`，下次触发 `/mana` 指令即自动创建新的 Discussion！
2. **兼容与降级**:
   - 既支持 `--sync-session <session.jsonl>` 直接同步会话，也支持 `--sync-mana <run_dir>`（若检测到同仓库活跃的 `/mana` 会话或传入 `--session-jsonl` 则自动合并至该 session 的 Discussion，否则回退为 `run_id` 独立态以保持离线单元测试 100% 兼容）；
   - 通过 `MANA_ECHO_LIVE=1` (或 `--live` / `~/.bashrc` 配置) 门控线上写入；任何网络/限流失败只记日志与 `last_error`、绝不阻断主流程 (exit 0)。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

# 已通过只读 GraphQL 核实的 41490/ipi 常量
DEFAULT_OWNER = "41490"
DEFAULT_REPO = "ipi"
DEFAULT_REPO_ID = "R_kgDOThYpRg"
DEFAULT_ECHO_CATEGORY_ID = "DIC_kwDOThYpRs4DBz3d"  # slug: echo ("Show off something you've made")

SGT = dt.timezone(dt.timedelta(hours=8), name="SGT")

MANA_CMD_RE = re.compile(r"(?:^|\s)/mana(?:\s|$)|【41490/ipi#\d+", re.IGNORECASE)

REDACT_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\b\d{6,12}:[A-Za-z0-9_-]{30,}\b"), "[REDACTED_BOT_TOKEN]"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{8,}"), "sk-[REDACTED]"),
    (re.compile(r"\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{10,}"), r"\1_[REDACTED]"),
    (re.compile(r"\b(xox[abpr]-|AKIA|AIza|re_)[A-Za-z0-9_-]{10,}"), r"\1[REDACTED]"),
    (re.compile(r"(?i)(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}"), r"\1 [REDACTED]"),
    (
        re.compile(
            r"""(?i)((?:api[_-]?key|secret|password|passwd|token|auth)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}"""
        ),
        r"\1[REDACTED]",
    ),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}"), "[REDACTED_JWT]"),
]


def now_sgt_str() -> str:
    return dt.datetime.now(SGT).strftime("%Y-%m-%d %H:%M:%S SGT")


def redact(text: str) -> str:
    out = str(text or "")
    for pat, repl in REDACT_RULES:
        out = pat.sub(repl, out)
    return out


def short_text(text: Any, limit: int = 160) -> str:
    compact = re.sub(r"\s+", " ", str(text or "")).strip()
    return compact[:limit] + "…" if len(compact) > limit else compact


def is_live_enabled(cli_live: bool = False, cli_dry_run: bool = False, env: dict[str, str] | None = None) -> bool:
    """判定是否启用线上 GraphQL 写入：--dry-run 强制关闭；否则 --live 或 MANA_ECHO_LIVE=1 开启。
    当 env 未显式指定且进程环境未包含 MANA_ECHO_LIVE 时，回退检查 ~/.bashrc / ~/.profile 中的 export MANA_ECHO_LIVE=1，
    确保在注入环境变量前已启动的旧 omp/herdr 会话派生子进程也能立即生效。"""
    if cli_dry_run:
        return False
    if cli_live:
        return True
    environ = env if env is not None else os.environ
    if "MANA_ECHO_LIVE" in environ:
        return environ.get("MANA_ECHO_LIVE") == "1"
    if env is None:
        for rc_name in (".bashrc", ".bash_profile", ".profile"):
            rc_path = Path.home() / rc_name
            try:
                if rc_path.exists() and re.search(
                    r"""^\s*export\s+MANA_ECHO_LIVE=['"]?1['"]?\b""",
                    rc_path.read_text(encoding="utf-8", errors="ignore"),
                    re.M,
                ):
                    return True
            except Exception:
                pass
    return False


def gh_graphql(query: str, variables: dict[str, Any], dry_run: bool = False) -> dict[str, Any]:
    if dry_run:
        return {"dry_run": True, "query": query.strip().splitlines()[0], "variables": variables}
    cmd = ["gh", "api", "graphql", "-f", f"query={query}"]
    for k, v in variables.items():
        if v is None:
            continue
        cmd.extend(["-F", f"{k}={v}"])
    res = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if res.returncode != 0:
        raise RuntimeError(f"gh api graphql failed ({res.returncode}): {res.stderr.strip()}")
    payload = json.loads(res.stdout)
    if "errors" in payload:
        raise RuntimeError(f"GraphQL errors: {json.dumps(payload['errors'], ensure_ascii=False)}")
    return payload.get("data") or {}


MUTATION_CREATE_DISCUSSION = """
mutation($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
  createDiscussion(input: {
    repositoryId: $repositoryId,
    categoryId: $categoryId,
    title: $title,
    body: $body
  }) {
    discussion { id number url title }
  }
}
"""

MUTATION_UPDATE_DISCUSSION = """
mutation($discussionId: ID!, $title: String, $body: String) {
  updateDiscussion(input: {
    discussionId: $discussionId,
    title: $title,
    body: $body
  }) {
    discussion { id number url title updatedAt }
  }
}
"""

MUTATION_ADD_COMMENT = """
mutation($discussionId: ID!, $body: String!, $replyToId: ID) {
  addDiscussionComment(input: {
    discussionId: $discussionId,
    body: $body,
    replyToId: $replyToId
  }) {
    comment { id url createdAt }
  }
}
"""

MUTATION_UPDATE_COMMENT = """
mutation($commentId: ID!, $body: String!) {
  updateDiscussionComment(input: {
    commentId: $commentId,
    body: $body
  }) {
    comment { id url updatedAt }
  }
}
"""


def distill_session_jsonl(
    session_path: Path,
    events_out: Path,
    start_offset: int = 0,
) -> tuple[int, list[dict[str, Any]]]:
    """按字节偏移增量尾随 pi/pig/omp 会话 JSONL，蒸馏为精简事件流落盘 lanes/<lane-id>.events.jsonl。"""
    if not session_path.exists():
        return start_offset, []
    size = session_path.stat().st_size
    if size < start_offset:
        start_offset = 0
    if size == start_offset:
        return start_offset, []

    with session_path.open("rb") as fh:
        fh.seek(start_offset)
        chunk = fh.read(size - start_offset)

    last_nl = chunk.rfind(b"\n")
    if last_nl == -1:
        return start_offset, []

    consumed = start_offset + last_nl + 1
    raw_lines = chunk[: last_nl + 1].decode("utf-8", errors="replace").splitlines()
    distilled: list[dict[str, Any]] = []

    for line in raw_lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        etype = obj.get("type")
        ts = obj.get("timestamp") or now_sgt_str()
        if etype == "model_change":
            distilled.append(
                {
                    "ts": ts,
                    "type": "model_change",
                    "provider": obj.get("provider"),
                    "modelId": obj.get("modelId") or obj.get("model"),
                }
            )
        elif etype in (
            "compaction_start",
            "compaction_end",
            "auto_retry_start",
            "auto_retry_end",
            "extension_error",
        ):
            distilled.append({"ts": ts, "type": etype, "detail": redact(short_text(obj, 200))})
        elif etype == "message" and isinstance(obj.get("message"), dict):
            msg = obj["message"]
            role = msg.get("role")
            content = msg.get("content")
            blocks = content if isinstance(content, list) else [{"type": "text", "text": str(content or "")}]
            usage = msg.get("usage") if isinstance(msg.get("usage"), dict) else {}
            tokens = usage.get("totalTokens")
            if role == "assistant":
                for blk in blocks:
                    if not isinstance(blk, dict):
                        continue
                    if blk.get("type") == "toolCall":
                        args = blk.get("arguments") if isinstance(blk.get("arguments"), dict) else {}
                        arg_val = (
                            args.get("command")
                            or args.get("path")
                            or args.get("pattern")
                            or args.get("url")
                            or json.dumps(args, ensure_ascii=False)
                        )
                        distilled.append(
                            {
                                "ts": ts,
                                "type": "tool_call",
                                "tool": str(blk.get("name") or "?"),
                                "arg": redact(short_text(arg_val, 160)),
                                "tokens": tokens,
                            }
                        )
            elif role == "toolResult":
                is_err = bool(msg.get("isError"))
                text_joined = " ".join(
                    str(b.get("text") or "") for b in blocks if isinstance(b, dict)
                )
                rec: dict[str, Any] = {
                    "ts": ts,
                    "type": "tool_result",
                    "tool": str(msg.get("toolName") or "?"),
                    "is_error": is_err,
                }
                if is_err:
                    rec["error"] = redact(short_text(text_joined, 200))
                distilled.append(rec)

    if distilled:
        events_out.parent.mkdir(parents=True, exist_ok=True)
        with events_out.open("a", encoding="utf-8") as out_fh:
            for item in distilled:
                out_fh.write(json.dumps(item, ensure_ascii=False) + "\n")

    return consumed, distilled


def load_lane_tool_trace(events_file: Path, max_items: int = 40) -> list[str]:
    """从 lanes/<lane-id>.events.jsonl 读取最近工具轨迹摘要，供折叠进 Lane 状态楼层的 <details>。"""
    if not events_file.exists():
        return []
    traces: list[str] = []
    try:
        for line in events_file.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            ev = json.loads(line)
            t = ev.get("type")
            if t == "tool_call":
                traces.append(f"🔧 {ev.get('tool', '?')}: {ev.get('arg', '')}")
            elif t == "tool_result" and ev.get("is_error"):
                traces.append(f"⚠️ {ev.get('tool', '?')} error: {ev.get('error', '')}")
            elif t in ("reflex_warn", "stalled_loop", "allow_path_blocked"):
                traces.append(f"🛡️ {t}: {ev.get('detail') or ev.get('reason') or ''}")
    except Exception:
        return []
    return traces[-max_items:]


def extract_session_id_from_stem(path: Path) -> str:
    """从会话文件名提取 UUID 或唯一标识，如 2026-10-23T02-25-17-001Z_01a16693-... -> 01a16693-..."""
    stem = path.stem
    if "_" in stem:
        return stem.split("_", 1)[1]
    return stem


def parse_session_jsonl(session_path: Path) -> dict[str, Any]:
    """解析 omp/pi 会话 JSONL，提取 session_id、cwd、model、以及所有用户指令回合（含是否命中 /mana）。"""
    info: dict[str, Any] = {
        "session_id": extract_session_id_from_stem(session_path),
        "session_path": str(session_path),
        "cwd": None,
        "title": None,
        "model": None,
        "started_at": None,
        "turns": [],
        "has_mana_command": False,
        "referenced_run_ids": [],
    }
    if not session_path.exists():
        return info

    current_turn: dict[str, Any] | None = None
    run_id_set: set[str] = set()

    try:
        lines = session_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except Exception:
        return info

    for idx, raw in enumerate(lines):
        raw = raw.strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except Exception:
            continue
        etype = obj.get("type")
        if etype == "session":
            if obj.get("id"):
                info["session_id"] = str(obj["id"])
            if obj.get("cwd"):
                info["cwd"] = str(obj["cwd"])
            if obj.get("timestamp"):
                info["started_at"] = str(obj["timestamp"])
        elif etype == "title" and obj.get("title"):
            info["title"] = str(obj["title"]).strip()
        elif etype == "model_change":
            m = obj.get("model") or (
                f"{obj.get('provider')}/{obj.get('modelId')}"
                if obj.get("provider") and obj.get("modelId")
                else None
            )
            if m and not info["model"]:
                info["model"] = str(m)
        elif etype == "message" and isinstance(obj.get("message"), dict):
            msg = obj["message"]
            role = msg.get("role")
            content = msg.get("content")
            blocks = content if isinstance(content, list) else [{"type": "text", "text": str(content or "")}]
            if role == "user":
                text = "\n".join(
                    str(b.get("text") or "")
                    for b in blocks
                    if isinstance(b, dict) and b.get("type") == "text"
                ).strip()
                if not text:
                    continue
                is_mana = bool(MANA_CMD_RE.search(text))
                if is_mana or info["has_mana_command"]:
                    if is_mana:
                        info["has_mana_command"] = True
                    turn_id = str(obj.get("id") or f"line-{idx}")
                    current_turn = {
                        "id": turn_id,
                        "prompt": text,
                        "timestamp": str(obj.get("timestamp") or now_sgt_str()),
                        "tool_trace": [],
                        "final_reply": None,
                        "tokens": 0,
                        "status": "running",
                    }
                    info["turns"].append(current_turn)
            elif role == "assistant" and current_turn is not None:
                usage = msg.get("usage") if isinstance(msg.get("usage"), dict) else {}
                if usage.get("totalTokens"):
                    current_turn["tokens"] += int(usage["totalTokens"])
                has_tool = False
                texts: list[str] = []
                for blk in blocks:
                    if not isinstance(blk, dict):
                        continue
                    if blk.get("type") == "toolCall":
                        has_tool = True
                        tname = str(blk.get("name") or "?")
                        args = blk.get("arguments") if isinstance(blk.get("arguments"), dict) else {}
                        arg_val = (
                            args.get("command")
                            or args.get("path")
                            or args.get("pattern")
                            or args.get("url")
                            or json.dumps(args, ensure_ascii=False)
                        )
                        arg_str = str(arg_val or "")
                        if re.search(r"mkdir\b|mana-run-lock\.py|echo-discussion-sink\.py\s+--sync-mana|>\s*[^\n]*\.mana/", arg_str):
                            for m_run in re.finditer(r"\.mana/(run-[A-Za-z0-9_.-]+)", arg_str):
                                run_id_set.add(m_run.group(1))
                        current_turn["tool_trace"].append(f"🔧 {tname}: {short_text(arg_str, 140)}")
                        if tname == "read" and "skill://mana" in arg_str:
                            info["has_mana_command"] = True
                    elif blk.get("type") == "text" and str(blk.get("text") or "").strip():
                        texts.append(str(blk["text"]).strip())
                stop_reason = msg.get("stopReason")
                if stop_reason in ("error", "aborted"):
                    current_turn["status"] = "error"
                elif not has_tool and stop_reason == "stop" and texts:
                    current_turn["final_reply"] = "\n\n".join(texts)
                    current_turn["status"] = "done"
            elif role == "toolResult" and current_turn is not None and msg.get("isError"):
                err_txt = " ".join(str(b.get("text") or "") for b in blocks if isinstance(b, dict))
                current_turn["tool_trace"].append(
                    f"⚠️ {msg.get('toolName', '?')} error: {short_text(err_txt, 140)}"
                )

    info["referenced_run_ids"] = sorted(run_id_set)
    return info


def format_root_body(
    meta: dict[str, Any],
    lanes: list[dict[str, Any]] | None = None,
    turns: list[dict[str, Any]] | None = None,
) -> str:
    title_id = meta.get("session_short") or meta.get("run_id") or "-"
    lines = [
        f"## 任务看板 · `{title_id}`",
        "",
        f"- **主机 / 引擎**: `{meta.get('host', '-')}` / `{meta.get('engine', 'omp+pi')}`",
        f"- **仓库 / 目录**: `{meta.get('cwd', '-')}`",
    ]
    if meta.get("session_id"):
        lines.append(f"- **Session ID**: `{meta['session_id']}`")
    if meta.get("run_id") and meta.get("run_id") != "-":
        lines.append(f"- **关联 Run**: `{meta['run_id']}`")
    lines.extend(
        [
            f"- **关联 Issue**: {meta.get('issue_ref', '-')}",
            f"- **状态**: **{meta.get('status', '🔄 running')}**",
            f"- **开始时间**: `{meta.get('started_at', now_sgt_str())}`",
            f"- **更新时间**: `{now_sgt_str()}`",
        ]
    )
    if meta.get("goal"):
        lines.extend(["", "### 目标与契约摘要", "", redact(str(meta["goal"]))])
    if turns:
        lines.extend(
            [
                "",
                "### Session 指令轨迹",
                "",
                "| # | 指令摘要 | 状态 | 工具步数 |",
                "| --- | --- | --- | --- |",
            ]
        )
        for i, t in enumerate(turns, 1):
            st_icon = "✅ done" if t.get("status") == "done" else ("❌ error" if t.get("status") == "error" else "🔄 running")
            prompt_one = redact(short_text(t.get("prompt", ""), 80)).replace("|", "\\|")
            lines.append(f"| `{i}` | `{prompt_one}` | {st_icon} | `{len(t.get('tool_trace') or [])}` |")
    if lanes:
        lines.extend(
            [
                "",
                "### Lane 状态矩阵",
                "",
                "| Lane | 状态 | 模型 | Attempt | Head SHA | 备注 |",
                "| --- | --- | --- | --- | --- | --- |",
            ]
        )
        for ln in lanes:
            lines.append(
                f"| `{ln.get('id', '?')}` | `{ln.get('status', '?')}` | `{ln.get('model', '-')}` "
                f"| `{ln.get('attempt', 1)}` | `{str(ln.get('head_sha') or '-')[:8]}` "
                f"| {redact(str(ln.get('verdict') or ln.get('note') or '-'))} |"
            )
    return "\n".join(lines) + "\n"


def format_step_comment(
    seq: int,
    phase: str,
    title: str,
    summary: str,
    tool_trace: list[str] | None = None,
    evidence: str | None = None,
    tokens: int | None = None,
) -> str:
    tok_badge = f" · `tokens≈{tokens}`" if tokens else ""
    lines = [
        f"### #{seq} · {now_sgt_str()} · `[{phase}]` {redact(title)}{tok_badge}",
        "",
        redact(summary.strip() or "-"),
    ]
    if tool_trace:
        lines.extend(
            [
                "",
                f"<details><summary>🔧 内部工具轨迹 ({len(tool_trace)} 步)</summary>",
                "",
                "```text",
                *[redact(t) for t in tool_trace[:40]],
                "```",
                "</details>",
            ]
        )
    if evidence:
        lines.extend(
            [
                "",
                "<details><summary>📎 验证 / 反射证据片段</summary>",
                "",
                "```text",
                redact(evidence.strip()[:3000]),
                "```",
                "</details>",
            ]
        )
    return "\n".join(lines) + "\n"


def parse_decisions_tsv(tsv_path: Path) -> list[dict[str, str]]:
    """读取 .mana/<run-id>/decisions.tsv (6 列表头: time, phase, decision, reason, evidence, result)。"""
    if not tsv_path.exists():
        return []
    rows: list[dict[str, str]] = []
    try:
        lines = tsv_path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return []
    for idx, line in enumerate(lines):
        if not line.strip():
            continue
        cols = line.split("\t")
        if idx == 0 and cols[:3] == ["time", "phase", "decision"]:
            continue
        if len(cols) >= 6:
            rows.append(
                {
                    "time": cols[0],
                    "phase": cols[1],
                    "decision": cols[2],
                    "reason": cols[3],
                    "evidence": cols[4],
                    "result": cols[5],
                }
            )
    return rows


class EchoSinkState:
    """持久化每个 session 或 run 对应的 Discussion ID、步骤序号与已同步水位, 保证幂等。"""

    def __init__(self, path: Path):
        self.path = path
        self.data: dict[str, Any] = {
            "session_id": None,
            "session_path": None,
            "discussion_id": None,
            "discussion_number": None,
            "discussion_url": None,
            "title": None,
            "step_seq": 0,
            "turn_comments": {},
            "lane_Anchor_comments": {},
            "synced_decision_count": 0,
            "synced_tsv_count": 0,
            "synced_lane_states": {},
            "session_offsets": {},
            "last_error": None,
        }
        if path.exists():
            try:
                self.data.update(json.loads(path.read_text(encoding="utf-8")))
            except Exception:
                pass

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(self.path)


def _sync_mana_run_into_sink(
    run_dir: Path,
    sink: EchoSinkState,
    dry_run: bool,
    session_meta: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any], list[dict[str, Any]]]:
    """将单个 .mana/<run-id> 的 lanes 与 decision_log/decisions.tsv 增量同步到给定的 sink 中。"""
    mana_state = json.loads((run_dir / "state.json").read_text(encoding="utf-8"))
    ops: list[dict[str, Any]] = []

    run_id = mana_state.get("run_id") or run_dir.name
    lanes = mana_state.get("lanes") or []

    # 0) 旁路蒸馏各 lane 的会话 JSONL -> lanes/<lane-id>.events.jsonl
    for ln in lanes:
        lid = str(ln.get("id") or "?")
        sess = ln.get("session_jsonl") or ln.get("agent_session")
        if isinstance(sess, dict):
            sess = sess.get("value") or sess.get("path")
        if not sess and not dry_run:
            cached_sess = (sink.data.get("session_paths") or {}).get(lid)
            if cached_sess:
                sess = cached_sess
            else:
                target = ln.get("agent_name") or ln.get("pane_id")
                if target:
                    try:
                        hr = subprocess.run(
                            ["herdr", "agent", "get", str(target)],
                            capture_output=True,
                            text=True,
                            timeout=3,
                            check=False,
                        )
                        if hr.returncode == 0 and hr.stdout.strip():
                            hdata = json.loads(hr.stdout)
                            asess = ((hdata.get("result") or {}).get("agent") or {}).get("agent_session") or {}
                            if isinstance(asess, dict) and asess.get("value"):
                                sess = str(asess["value"])
                                sink.data.setdefault("session_paths", {})[lid] = sess
                    except Exception:
                        pass
        if isinstance(sess, str) and sess.strip():
            s_path = Path(sess.strip())
            ev_path = run_dir / "lanes" / f"{lid}.events.jsonl"
            prev_off = int(sink.data.get("session_offsets", {}).get(lid) or 0)
            new_off, _ = distill_session_jsonl(s_path, ev_path, prev_off)
            sink.data.setdefault("session_offsets", {})[lid] = new_off

    all_done = bool(lanes) and all(
        ln.get("status") in ("reclaimed", "verified", "landed") for ln in lanes
    )
    any_blocked = any(ln.get("status") in ("blocked", "failed", "stalled_loop") for ln in lanes)
    status_badge = "✅ done" if all_done else ("⏸ blocked" if any_blocked else "🔄 running")

    if session_meta and session_meta.get("session_short"):
        sess_short = session_meta["session_short"]
        title = f"[echo] mana · sess:{sess_short} · {run_id} · {status_badge}"
    else:
        title = f"[echo] mana · {run_id} · {status_badge}"

    meta = {
        "run_id": run_id,
        "session_id": session_meta.get("session_id") if session_meta else sink.data.get("session_id"),
        "session_short": session_meta.get("session_short") if session_meta else None,
        "host": os.uname().nodename,
        "engine": f"omp + {mana_state.get('worker_model', 'pi')}",
        "cwd": str(run_dir.parent.parent),
        "issue_ref": str(mana_state.get("issue") or (mana_state.get("authorization") or {}).get("issue") or "-"),
        "status": status_badge,
        "goal": mana_state.get("goal") or "",
        "started_at": (session_meta or {}).get("started_at") or mana_state.get("started_at") or now_sgt_str(),
    }
    turns = (session_meta or {}).get("turns") or []
    root_body = format_root_body(meta, lanes, turns=turns or None)

    if not sink.data["discussion_id"]:
        res = gh_graphql(
            MUTATION_CREATE_DISCUSSION,
            {
                "repositoryId": DEFAULT_REPO_ID,
                "categoryId": DEFAULT_ECHO_CATEGORY_ID,
                "title": title,
                "body": root_body,
            },
            dry_run=dry_run,
        )
        disc = (res.get("createDiscussion") or {}).get("discussion") or {
            "id": "D_dryrun_root",
            "number": 0,
            "url": "https://github.com/41490/ipi/discussions/0",
        }
        sink.data["discussion_id"] = disc["id"]
        sink.data["discussion_number"] = disc["number"]
        sink.data["discussion_url"] = disc["url"]
        sink.data["title"] = title
        ops.append({"op": "createDiscussion", "title": title, "result": disc})

    # 1) Lane 状态跃迁 -> 顶层 lane 锚点或二级回复 (方案 A；running 期间工具轨迹增量静默原地刷新)
    for ln in lanes:
        lid = str(ln.get("id") or "?")
        lstatus = str(ln.get("status") or "planned")
        lattempt = int(ln.get("attempt") or 1)
        legacy_key = f"{lid}:{lstatus}:{lattempt}:{ln.get('head_sha') or ''}"
        key = f"{run_id}:{legacy_key}"
        ev_file = run_dir / "lanes" / f"{lid}.events.jsonl"
        tool_trace = load_lane_tool_trace(ev_file)
        summary = (
            f"Lane `{lid}` 状态跃迁为 **`{lstatus}`** (attempt={lattempt}, "
            f"model=`{ln.get('model') or mana_state.get('worker_model') or '-'}`, "
            f"head_sha=`{ln.get('head_sha') or '-'}`)"
        )
        if sink.data["synced_lane_states"].get(lid) in (key, legacy_key):
            last_meta = (sink.data.get("lane_last_comments") or {}).get(lid) or {}
            last_cid = last_meta.get("id")
            last_seq = int(last_meta.get("seq") or sink.data["step_seq"] or 1)
            last_tcount = int(last_meta.get("trace_count") or 0)
            last_ts = float(last_meta.get("updated_at") or 0.0)
            if (
                last_cid
                and lstatus in ("running", "verifying")
                and len(tool_trace) != last_tcount
                and (time.time() - last_ts >= 15.0 or dry_run)
            ):
                body = format_step_comment(
                    seq=last_seq,
                    phase=f"lane:{lid}",
                    title=f"{lid} -> {lstatus} (attempt {lattempt})",
                    summary=summary,
                    tool_trace=tool_trace or None,
                    evidence=ln.get("acceptance_output") or ln.get("verdict"),
                )
                gh_graphql(
                    MUTATION_UPDATE_COMMENT,
                    {"commentId": last_cid, "body": body},
                    dry_run=dry_run,
                )
                sink.data.setdefault("lane_last_comments", {})[lid] = {
                    "id": last_cid,
                    "seq": last_seq,
                    "trace_count": len(tool_trace),
                    "updated_at": time.time(),
                }
                ops.append({"op": "updateDiscussionComment", "lane": lid, "seq": last_seq, "commentId": last_cid})
            continue
        sink.data["step_seq"] += 1
        seq = sink.data["step_seq"]
        body = format_step_comment(
            seq=seq,
            phase=f"lane:{lid}",
            title=f"{lid} -> {lstatus} (attempt {lattempt})",
            summary=summary,
            tool_trace=tool_trace or None,
            evidence=ln.get("acceptance_output") or ln.get("verdict"),
        )
        parent_id = sink.data["lane_Anchor_comments"].get(lid)
        res = gh_graphql(
            MUTATION_ADD_COMMENT,
            {
                "discussionId": sink.data["discussion_id"],
                "body": body,
                "replyToId": parent_id,
            },
            dry_run=dry_run,
        )
        cnode = (res.get("addDiscussionComment") or {}).get("comment") or {
            "id": f"DC_dryrun_{seq}"
        }
        if not parent_id:
            sink.data["lane_Anchor_comments"][lid] = cnode["id"]
        sink.data["synced_lane_states"][lid] = key
        sink.data.setdefault("lane_last_comments", {})[lid] = {
            "id": cnode["id"],
            "seq": seq,
            "trace_count": len(tool_trace),
            "updated_at": time.time(),
        }
        ops.append({"op": "addDiscussionComment", "lane": lid, "seq": seq, "replyToId": parent_id})

    # 2) decision_log 与 decisions.tsv 新增条目 -> 反射/决策回复
    dlog = mana_state.get("decision_log") or []
    start_idx = int(sink.data.get("synced_decision_count") or 0)
    seen_keys: set[tuple[str, str]] = set()
    for entry in dlog:
        if isinstance(entry, dict):
            seen_keys.add((str(entry.get("phase") or "decision"), str(entry.get("decision") or entry.get("decided") or "-")))

    for entry in dlog[start_idx:]:
        sink.data["step_seq"] += 1
        seq = sink.data["step_seq"]
        reply_to = None
        if isinstance(entry, dict):
            phase = str(entry.get("phase") or "decision")
            dec = str(entry.get("decision") or entry.get("decided") or "-")
            reason = str(entry.get("reason") or "")
            ev = str(entry.get("evidence") or "")
            summary = f"**决策**: {dec}\n\n**原因**: {reason}" if reason else dec
            target_lane = entry.get("lane")
            if target_lane and target_lane in sink.data["lane_Anchor_comments"]:
                reply_to = sink.data["lane_Anchor_comments"][target_lane]
        else:
            phase, dec, summary, ev = "decision", str(entry), str(entry), ""
        body = format_step_comment(
            seq=seq,
            phase=phase,
            title=dec[:72],
            summary=summary,
            evidence=ev or None,
        )
        req_vars: dict[str, Any] = {"discussionId": sink.data["discussion_id"], "body": body}
        if reply_to:
            req_vars["replyToId"] = reply_to
        gh_graphql(
            MUTATION_ADD_COMMENT,
            req_vars,
            dry_run=dry_run,
        )
        ops.append({"op": "addDiscussionComment", "phase": phase, "seq": seq, **({"replyToId": reply_to} if reply_to else {})})
    sink.data["synced_decision_count"] = len(dlog)

    tsv_rows = parse_decisions_tsv(run_dir / "decisions.tsv")
    tsv_start = int(sink.data.get("synced_tsv_count") or 0)
    for row in tsv_rows[tsv_start:]:
        phase = row["phase"] or "decision"
        dec = row["decision"] or "-"
        if (phase, dec) in seen_keys:
            continue
        sink.data["step_seq"] += 1
        seq = sink.data["step_seq"]
        reason = row.get("reason") or ""
        ev = row.get("evidence") or ""
        res_col = row.get("result") or ""
        summary_parts = [f"**决策**: {dec}"]
        if reason:
            summary_parts.append(f"**原因**: {reason}")
        if res_col:
            summary_parts.append(f"**结果**: `{res_col}`")
        body = format_step_comment(
            seq=seq,
            phase=phase,
            title=dec[:72],
            summary="\n\n".join(summary_parts),
            evidence=ev or None,
        )
        reply_to = None
        for lid, anchor_id in sink.data["lane_Anchor_comments"].items():
            if lid in phase or lid in dec:
                reply_to = anchor_id
                break
        req_vars = {"discussionId": sink.data["discussion_id"], "body": body}
        if reply_to:
            req_vars["replyToId"] = reply_to
        gh_graphql(MUTATION_ADD_COMMENT, req_vars, dry_run=dry_run)
        ops.append({"op": "addDiscussionComment", "phase": phase, "seq": seq, "source": "decisions.tsv", "replyToId": reply_to})
    sink.data["synced_tsv_count"] = len(tsv_rows)

    return ops, meta, lanes


def sync_mana_run(run_dir: Path, state_file: Path, dry_run: bool = True) -> list[dict[str, Any]]:
    """读取 mana 的 .mana/<run-id>/state.json (及可选 decisions.tsv / 会话 JSONL),
    按方案 A 增量映射为 41490/ipi echo 分类下的 1 个主帖 + 每个阶段/决策/状态跃迁 1 条回复。"""
    sink = EchoSinkState(state_file)
    if sink.data.get("managed_by_session") and not dry_run:
        return []
    ops, meta, lanes = _sync_mana_run_into_sink(run_dir, sink, dry_run=dry_run, session_meta=None)
    title = f"[echo] mana · {meta['run_id']} · {meta['status']}"
    root_body = format_root_body(meta, lanes)
    if ops:
        gh_graphql(
            MUTATION_UPDATE_DISCUSSION,
            {
                "discussionId": sink.data["discussion_id"],
                "title": title,
                "body": root_body,
            },
            dry_run=dry_run,
        )
        ops.append({"op": "updateDiscussion", "title": title})
    sink.data["title"] = title
    sink.data["last_error"] = None
    sink.save()
    return ops


def resolve_session_state_file(session_path: Path, repo_dir: Path | None = None) -> tuple[Path, Path]:
    """根据会话 JSONL 确定所属 repo 目录与状态文件 `<repo>/.mana/echo-sessions/<session_id>.json`。"""
    sess_info = parse_session_jsonl(session_path)
    session_id = sess_info["session_id"]
    if repo_dir is None:
        cwd = sess_info.get("cwd")
        if cwd and Path(cwd).is_dir():
            repo_dir = Path(cwd)
        else:
            repo_dir = session_path.parent
    state_file = repo_dir / ".mana" / "echo-sessions" / f"{session_id}.json"
    return repo_dir, state_file


def sync_session(
    session_path: Path,
    state_file: Path | None = None,
    repo_dir: Path | None = None,
    dry_run: bool = True,
) -> list[dict[str, Any]]:
    """按 Session 粒度同步：
    1 个 session (.jsonl) = 1 个 Discussion 主帖；
    每当在 session 中执行 `/mana ...` 指令（无论 recall/how/why/run），立即建帖或追加 `[session:turn]` 楼层；
    若该 session 关联了 `.mana/<run-id>`，则将该 run 的 Lane 状态跃迁与 `decisions.tsv` 一并同步至同一 Discussion；
    当用户 `/new` 或 `/q` 重启进程产生新 session `.jsonl` 时，因 `session_id` 不同，自动创建对应的新 Discussion！
    """
    sess_info = parse_session_jsonl(session_path)
    if not sess_info["has_mana_command"]:
        return []

    import fcntl
    resolved_repo, default_state_file = resolve_session_state_file(session_path, repo_dir)
    target_state_file = state_file or default_state_file
    target_state_file.parent.mkdir(parents=True, exist_ok=True)
    lock_file = target_state_file.with_suffix(".lock")
    with lock_file.open("a+", encoding="utf-8") as lock_fh:
        try:
            fcntl.flock(lock_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return []
        return _sync_session_locked(sess_info, session_path, resolved_repo, target_state_file, dry_run=dry_run)


def _sync_session_locked(
    sess_info: dict[str, Any],
    session_path: Path,
    resolved_repo: Path,
    target_state_file: Path,
    dry_run: bool = True,
) -> list[dict[str, Any]]:
    sink = EchoSinkState(target_state_file)

    session_id = sess_info["session_id"]
    sess_short = session_id.split("-")[0] if "-" in session_id else session_id[:8]
    sink.data["session_id"] = session_id
    sink.data["session_path"] = str(session_path)

    turns = sess_info["turns"]
    all_turns_done = bool(turns) and all(t.get("status") == "done" for t in turns)
    any_turn_err = any(t.get("status") == "error" for t in turns)
    status_badge = "✅ done" if all_turns_done else ("❌ error" if any_turn_err else "🔄 running")

    first_prompt = short_text(turns[0]["prompt"], 48) if turns else (sess_info.get("title") or "mana")
    repo_name = resolved_repo.name
    title = f"[echo] mana · {repo_name} · sess:{sess_short} · {first_prompt} · {status_badge}"

    meta: dict[str, Any] = {
        "session_id": session_id,
        "session_short": sess_short,
        "run_id": ", ".join(sess_info["referenced_run_ids"]) or "-",
        "host": os.uname().nodename,
        "engine": f"omp + {sess_info.get('model') or 'pi'}",
        "cwd": str(resolved_repo),
        "issue_ref": "-",
        "status": status_badge,
        "goal": turns[-1]["prompt"] if turns else (sess_info.get("title") or ""),
        "started_at": sess_info.get("started_at") or now_sgt_str(),
    }

    ops: list[dict[str, Any]] = []
    root_body = format_root_body(meta, lanes=None, turns=turns)

    # 0b) 若本 session 关联的某个 .mana/<run-id> 之前已建过 echo-state.json（而本 session 尚未建帖），直接继承其 Discussion ID 与水位，避免重复建帖
    for run_id in sess_info["referenced_run_ids"]:
        rdir = resolved_repo / ".mana" / run_id
        existing_echo = rdir / "echo-state.json"
        if existing_echo.is_file():
            try:
                ex_data = json.loads(existing_echo.read_text(encoding="utf-8"))
                if (
                    ex_data.get("discussion_id")
                    and not sink.data.get("discussion_id")
                    and ex_data.get("managed_by_session") in (None, session_id)
                ):
                    for k in ("discussion_id", "discussion_number", "discussion_url", "step_seq", "lane_Anchor_comments", "synced_decision_count", "synced_tsv_count", "synced_lane_states", "session_offsets", "session_paths", "lane_last_comments"):
                        if k in ex_data:
                            sink.data[k] = ex_data[k]
            except Exception:
                pass

    if not sink.data["discussion_id"]:
        res = gh_graphql(
            MUTATION_CREATE_DISCUSSION,
            {
                "repositoryId": DEFAULT_REPO_ID,
                "categoryId": DEFAULT_ECHO_CATEGORY_ID,
                "title": title,
                "body": root_body,
            },
            dry_run=dry_run,
        )
        disc = (res.get("createDiscussion") or {}).get("discussion") or {
            "id": f"D_dryrun_sess_{sess_short}",
            "number": 0,
            "url": "https://github.com/41490/ipi/discussions/0",
        }
        sink.data["discussion_id"] = disc["id"]
        sink.data["discussion_number"] = disc["number"]
        sink.data["discussion_url"] = disc["url"]
        sink.data["title"] = title
        ops.append({"op": "createDiscussion", "session_id": session_id, "title": title, "result": disc})

    # 1) 同步本 session 中的每个用户指令回合 (turn)
    turn_comments: dict[str, Any] = sink.data.setdefault("turn_comments", {})
    for idx, turn in enumerate(turns, 1):
        tid = turn["id"]
        t_status = turn["status"]
        t_trace = turn["tool_trace"]
        t_reply = turn.get("final_reply") or ""
        t_state_key = f"{t_status}:{len(t_trace)}:{len(t_reply)}"

        summary_lines = [f"**指令 (`#{idx}`)**: `{short_text(turn['prompt'], 240)}`", f"- **状态**: `{t_status}`"]
        if t_reply:
            summary_lines.extend(["", "#### 回复摘要", "", short_text(t_reply, 1200)])
        body = format_step_comment(
            seq=int(turn_comments.get(tid, {}).get("seq") or (sink.data["step_seq"] + 1)),
            phase=f"session:turn-{idx}",
            title=short_text(turn["prompt"], 64),
            summary="\n".join(summary_lines),
            tool_trace=t_trace or None,
            tokens=turn.get("tokens") or None,
        )

        if tid not in turn_comments:
            sink.data["step_seq"] += 1
            seq = sink.data["step_seq"]
            body = format_step_comment(
                seq=seq,
                phase=f"session:turn-{idx}",
                title=short_text(turn["prompt"], 64),
                summary="\n".join(summary_lines),
                tool_trace=t_trace or None,
                tokens=turn.get("tokens") or None,
            )
            res = gh_graphql(
                MUTATION_ADD_COMMENT,
                {"discussionId": sink.data["discussion_id"], "body": body},
                dry_run=dry_run,
            )
            cnode = (res.get("addDiscussionComment") or {}).get("comment") or {"id": f"DC_dryrun_turn_{seq}"}
            turn_comments[tid] = {
                "id": cnode["id"],
                "seq": seq,
                "state_key": t_state_key,
                "updated_at": time.time(),
            }
            ops.append({"op": "addDiscussionComment", "phase": f"session:turn-{idx}", "seq": seq, "turn_id": tid})
        else:
            prev_meta = turn_comments[tid]
            if prev_meta.get("state_key") != t_state_key:
                # 若回合刚完成 (done/error) 立即刷新；若仍在 running 则节流 15s 刷新
                if t_status in ("done", "error") or (time.time() - float(prev_meta.get("updated_at") or 0) >= 15.0) or dry_run:
                    gh_graphql(
                        MUTATION_UPDATE_COMMENT,
                        {"commentId": prev_meta["id"], "body": body},
                        dry_run=dry_run,
                    )
                    prev_meta["state_key"] = t_state_key
                    prev_meta["updated_at"] = time.time()
                    ops.append({"op": "updateDiscussionComment", "phase": f"session:turn-{idx}", "seq": prev_meta["seq"], "turn_id": tid})

    # 2) 若该 session 关联了 .mana/<run-id>，将该 run 的 Lane 跃迁与 decisions.tsv 同步进同一个 Session Discussion
    latest_lanes: list[dict[str, Any]] | None = None
    for run_id in sess_info["referenced_run_ids"]:
        rdir = resolved_repo / ".mana" / run_id
        sjson = rdir / "state.json"
        if sjson.is_file():
            try:
                if not dry_run and (session_path.stat().st_ctime - sjson.stat().st_mtime) > 3600:
                    continue
            except OSError:
                pass
            # 若该 run_dir 之前已被旧守护创建过独立 echo-state.json 且当前 session 刚建，或者共享当前 session sink
            run_ops, run_meta, run_lanes = _sync_mana_run_into_sink(
                rdir,
                sink,
                dry_run=dry_run,
                session_meta={"session_id": session_id, "session_short": sess_short, "turns": turns, "started_at": meta["started_at"]},
            )
            ops.extend(run_ops)
            latest_lanes = run_lanes
            meta["issue_ref"] = run_meta.get("issue_ref") or meta["issue_ref"]
            # 在 run_dir/echo-state.json 标记 managed_by_session，防止 --sync-mana 重复处理或覆盖主帖看板
            try:
                run_echo = EchoSinkState(rdir / "echo-state.json")
                run_echo.data["managed_by_session"] = session_id
                run_echo.data["discussion_id"] = sink.data["discussion_id"]
                run_echo.data["discussion_number"] = sink.data["discussion_number"]
                run_echo.data["discussion_url"] = sink.data["discussion_url"]
                run_echo.save()
            except Exception:
                pass

    if ops:
        final_body = format_root_body(meta, lanes=latest_lanes, turns=turns)
        gh_graphql(
            MUTATION_UPDATE_DISCUSSION,
            {
                "discussionId": sink.data["discussion_id"],
                "title": title,
                "body": final_body,
            },
            dry_run=dry_run,
        )
        ops.append({"op": "updateDiscussion", "title": title})

    sink.data["title"] = title
    sink.data["last_error"] = None
    sink.save()
    return ops


def safe_sync_session(
    session_path: Path,
    state_file: Path | None = None,
    repo_dir: Path | None = None,
    dry_run: bool = True,
) -> dict[str, Any]:
    """Session 同步非阻断包装。"""
    try:
        ops = sync_session(session_path, state_file=state_file, repo_dir=repo_dir, dry_run=dry_run)
        return {"ok": True, "dry_run": dry_run, "session_path": str(session_path), "ops": ops}
    except Exception as exc:
        err_msg = redact(str(exc))
        print(f"echo-discussion-sink: WARN: session 同步失败（已降级忽略）: {err_msg}", file=sys.stderr)
        return {"ok": False, "dry_run": dry_run, "error": err_msg, "ops": []}


def safe_sync_mana_run(run_dir: Path, state_file: Path, dry_run: bool = True) -> dict[str, Any]:
    """非阻断包装：任何异常只记日志并落盘 last_error，绝不抛出阻断 mana 主流程。"""
    try:
        ops = sync_mana_run(run_dir, state_file, dry_run=dry_run)
        return {"ok": True, "dry_run": dry_run, "ops": ops}
    except Exception as exc:
        err_msg = redact(str(exc))
        print(f"echo-discussion-sink: WARN: 同步失败（已降级忽略，不阻断主流程）: {err_msg}", file=sys.stderr)
        try:
            sink = EchoSinkState(state_file)
            sink.data["last_error"] = err_msg
            sink.save()
        except Exception:
            pass
        return {"ok": False, "dry_run": dry_run, "error": err_msg, "ops": []}


def discover_repo_sessions(repo_dir: Path, max_age_sec: float = 1200.0) -> list[Path]:
    """扫描 ~/.omp/agent/sessions 与 ~/.pi/agent/sessions 中匹配 repo_dir 的近期会话 JSONL。"""
    slug = "--" + str(repo_dir.resolve()).strip("/").replace("/", "-") + "--"
    found: list[Path] = []
    now = time.time()
    for agent_dir in (Path.home() / ".omp" / "agent" / "sessions", Path.home() / ".pi" / "agent" / "sessions"):
        candidate_dir = agent_dir / slug
        if not candidate_dir.is_dir():
            continue
        for jf in candidate_dir.glob("*.jsonl"):
            if jf.name < "2026-10-23T01":
                continue
            try:
                if (now - jf.stat().st_mtime) <= max_age_sec:
                    found.append(jf)
            except OSError:
                continue
    return sorted(found, key=lambda p: p.stat().st_mtime)


def run_selftest() -> None:
    import tempfile

    # 1. 验证遮蔽规则
    sample = "token ghp_1234567890abcdef and sk-proj1234567890 and 123456789:AAHabcdefghijklmnopqrstuvwx123456"
    masked = redact(sample)
    assert "ghp_[REDACTED]" in masked, masked
    assert "sk-[REDACTED]" in masked, masked
    assert "[REDACTED_BOT_TOKEN]" in masked, masked

    # 1b. 验证 MANA_ECHO_LIVE=1 门控逻辑
    assert not is_live_enabled(False, False, {}), "默认未设置 MANA_ECHO_LIVE 应为 dry-run"
    assert not is_live_enabled(False, False, {"MANA_ECHO_LIVE": "0"}), "MANA_ECHO_LIVE=0 应为 dry-run"
    assert is_live_enabled(False, False, {"MANA_ECHO_LIVE": "1"}), "MANA_ECHO_LIVE=1 应开启 live"
    assert is_live_enabled(True, False, {}), "--live 应开启 live"
    assert not is_live_enabled(True, True, {"MANA_ECHO_LIVE": "1"}), "--dry-run 优先级最高"

    # 2. 验证 mana run 增量同步与幂等性 (dry-run, 零网络写入) + 会话 JSONL 蒸馏 + decisions.tsv
    with tempfile.TemporaryDirectory() as tmp:
        rdir = Path(tmp) / ".mana" / "run-88-demo"
        rdir.mkdir(parents=True)
        sfile = rdir / "echo-state.json"
        sess_file = Path(tmp) / "worker-session.jsonl"
        sess_file.write_text(
            "\n".join(
                [
                    json.dumps({"type": "model_change", "provider": "omniroute", "modelId": "omni0free"}),
                    json.dumps(
                        {
                            "type": "message",
                            "message": {
                                "role": "assistant",
                                "usage": {"totalTokens": 1200},
                                "content": [
                                    {"type": "toolCall", "name": "bash", "arguments": {"command": "node checks/all.check.mjs"}}
                                ],
                            },
                        }
                    ),
                    json.dumps(
                        {
                            "type": "message",
                            "message": {
                                "role": "toolResult",
                                "toolName": "bash",
                                "isError": False,
                                "content": [{"type": "text", "text": "ALL-16-rc=0"}],
                            },
                        }
                    ),
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        (rdir / "state.json").write_text(
            json.dumps(
                {
                    "run_id": "run-88-demo",
                    "issue": "chaos42dama/mana#88",
                    "worker_model": "omniroute/omni0free",
                    "goal": "验证 echo discussion sink 增量盖楼",
                    "lanes": [
                        {
                            "id": "lane-a",
                            "status": "running",
                            "attempt": 1,
                            "session_jsonl": str(sess_file),
                        },
                    ],
                    "decision_log": [
                        {
                            "time": "2026-10-23T00:50:00Z",
                            "phase": "dispatch",
                            "decision": "派发 lane-a",
                            "reason": "tier A 预检通过",
                            "evidence": "PREFLIGHT PASS",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        ops1 = sync_mana_run(rdir, sfile, dry_run=True)
        assert [o["op"] for o in ops1] == [
            "createDiscussion",
            "addDiscussionComment",
            "addDiscussionComment",
            "updateDiscussion",
        ], ops1
        ev_out = rdir / "lanes" / "lane-a.events.jsonl"
        assert ev_out.exists(), "应旁路蒸馏生成 lanes/lane-a.events.jsonl"
        ev_lines = [json.loads(x) for x in ev_out.read_text(encoding="utf-8").splitlines() if x.strip()]
        assert len(ev_lines) == 3 and ev_lines[1]["tool"] == "bash", ev_lines

        # 再次同步无变化 -> 0 操作 (严格幂等，且 events.jsonl 不重复追加)
        ops2 = sync_mana_run(rdir, sfile, dry_run=True)
        assert ops2 == [], ops2
        assert len(ev_out.read_text(encoding="utf-8").splitlines()) == 3

        # 状态跃迁 running -> verified -> 走 replyToId 挂在 lane-a 锚点下
        (rdir / "state.json").write_text(
            json.dumps(
                {
                    "run_id": "run-88-demo",
                    "issue": "chaos42dama/mana#88",
                    "worker_model": "omniroute/omni0free",
                    "goal": "验证 echo discussion sink 增量盖楼",
                    "lanes": [
                        {
                            "id": "lane-a",
                            "status": "verified",
                            "attempt": 1,
                            "head_sha": "64b6e8d123456",
                            "verdict": "ALL-16-rc=0",
                            "session_jsonl": str(sess_file),
                        },
                    ],
                    "decision_log": [
                        {
                            "time": "2026-10-23T00:50:00Z",
                            "phase": "dispatch",
                            "decision": "派发 lane-a",
                            "reason": "tier A 预检通过",
                            "evidence": "PREFLIGHT PASS",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        ops3 = sync_mana_run(rdir, sfile, dry_run=True)
        assert len(ops3) == 2 and ops3[0]["op"] == "addDiscussionComment", ops3
        assert ops3[0]["replyToId"] == "DC_dryrun_1", ops3

        # decisions.tsv 新增反射条目 -> 同步并挂在对应 lane 锚点下
        (rdir / "decisions.tsv").write_text(
            "time\tphase\tdecision\treason\tevidence\tresult\n"
            "2026-10-23T00:51:00Z\treflex:lane-a\t触发连续报错反射提示\t连续 3 次报错\tbash exit 1\tinjected\n",
            encoding="utf-8",
        )
        ops4 = sync_mana_run(rdir, sfile, dry_run=True)
        assert len(ops4) == 2 and ops4[0]["source"] == "decisions.tsv", ops4
        assert ops4[0]["replyToId"] == "DC_dryrun_1", ops4

        # 3. 验证 Session 级 Echo 反射：1 个 session = 1 个 Discussion；/new 或重启换 session -> 新建 Discussion
        sess1 = Path(tmp) / "2026-10-23T02-25-17-001Z_01a16693-aec9-7701-abde-793a8ab7f620.jsonl"
        sess1.write_text(
            "\n".join(
                [
                    json.dumps({"type": "session", "id": "01a16693-aec9-7701-abde-793a8ab7f620", "cwd": str(tmp)}),
                    json.dumps(
                        {
                            "type": "message",
                            "id": "m1",
                            "message": {"role": "user", "content": [{"type": "text", "text": "/mana recall #1518 当前进展"}]},
                        }
                    ),
                    json.dumps(
                        {
                            "type": "message",
                            "id": "m2",
                            "message": {
                                "role": "assistant",
                                "stopReason": "stop",
                                "content": [{"type": "text", "text": "已完成 #1518 recall 梳理"}],
                            },
                        }
                    ),
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        s_ops1 = sync_session(sess1, repo_dir=Path(tmp), dry_run=True)
        assert [o["op"] for o in s_ops1] == ["createDiscussion", "addDiscussionComment", "updateDiscussion"], s_ops1
        # 同一 session 再次同步 -> 幂等 0 操作
        assert sync_session(sess1, repo_dir=Path(tmp), dry_run=True) == []
        # 同一 session 内追加第二条 /mana 指令 -> 复用同一 Discussion 追加 turn-2 楼层，不新建 Discussion
        with sess1.open("a", encoding="utf-8") as fh:
            fh.write(
                json.dumps(
                    {
                        "type": "message",
                        "id": "m3",
                        "message": {"role": "user", "content": [{"type": "text", "text": "/mana echo #1580"}]},
                    }
                )
                + "\n"
            )
        s_ops2 = sync_session(sess1, repo_dir=Path(tmp), dry_run=True)
        assert [o["op"] for o in s_ops2] == ["addDiscussionComment", "updateDiscussion"], s_ops2

        # 用户执行 /new 或 /q 重启进程 -> 生成新 session_id -> 自动创建全新的 Discussion！
        sess2 = Path(tmp) / "2026-10-23T03-00-00-001Z_01b27700-1111-2222-3333-444455556666.jsonl"
        sess2.write_text(
            "\n".join(
                [
                    json.dumps({"type": "session", "id": "01b27700-1111-2222-3333-444455556666", "cwd": str(tmp)}),
                    json.dumps(
                        {
                            "type": "message",
                            "id": "n1",
                            "message": {"role": "user", "content": [{"type": "text", "text": "/mana recall #224"}]},
                        }
                    ),
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        s_ops3 = sync_session(sess2, repo_dir=Path(tmp), dry_run=True)
        assert s_ops3[0]["op"] == "createDiscussion" and s_ops3[0]["session_id"] == "01b27700-1111-2222-3333-444455556666", s_ops3

    print("echo-discussion-sink selftest OK (redact + create + idempotent + nested replyToId + events.jsonl + session-based reflection + MANA_ECHO_LIVE gate)")


def watch_repo(repo_dir: Path, live: bool, interval_sec: float = 3.0, max_idle_sec: float = 1800.0) -> None:
    """单实例后台实时尾随守护：每 3s 扫描本仓活跃 session JSONL 与 repo/.mana/*/state.json，秒级反射到 echo 讨论区。"""
    import fcntl
    import hashlib

    mana_root = repo_dir / ".mana"
    repo_hash = hashlib.sha256(str(repo_dir.resolve()).encode("utf-8")).hexdigest()[:16]
    lock_path = Path(f"/tmp/mana-echo-watch-{repo_hash}.lock")
    with lock_path.open("a+", encoding="utf-8") as lock_fh:
        try:
            fcntl.flock(lock_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        last_active = time.time()
        while True:
            now = time.time()
            has_recent = False
            # 1) 优先按 Session 粒度扫描当前仓库的 omp/pi 会话 JSONL
            for sess_file in discover_repo_sessions(repo_dir, max_age_sec=1200.0):
                try:
                    if (now - sess_file.stat().st_mtime) <= 1800:
                        has_recent = True
                except OSError:
                    continue
                safe_sync_session(sess_file, repo_dir=repo_dir, dry_run=not live)

            # 2) 扫描 .mana/*/state.json（若已被某个 session 纳管并共享 discussion_id 则增量更新，否则按 run 兜底）
            if mana_root.is_dir():
                for sfile in mana_root.glob("*/state.json"):
                    rdir = sfile.parent
                    try:
                        mtime = sfile.stat().st_mtime
                    except OSError:
                        continue
                    if (now - mtime) <= 7200 or (rdir / "echo-state.json").exists():
                        if (now - mtime) <= 1800:
                            has_recent = True
                        safe_sync_mana_run(rdir, rdir / "echo-state.json", dry_run=not live)
            if has_recent:
                last_active = now
            elif (now - last_active) >= max_idle_sec:
                break
            time.sleep(interval_sec)


def main() -> None:
    ap = argparse.ArgumentParser(description="Sync agent execution steps to 41490/ipi echo Discussions")
    ap.add_argument("--self-test", action="store_true", help="Run offline self-test")
    ap.add_argument("--sync-session", type=Path, help="Path to omp/pi session .jsonl file (1 session = 1 Discussion)")
    ap.add_argument("--repo", type=Path, help="Optional repo root path for --sync-session")
    ap.add_argument("--sync-mana", type=Path, help="Path to .mana/<run-id> directory")
    ap.add_argument("--watch-repo", type=Path, help="Watch <repo> sessions and .mana/*/state.json in real-time (3s interval)")
    ap.add_argument("--distill-session", type=Path, help="Path to worker session .jsonl to distill")
    ap.add_argument("--out", type=Path, help="Output .events.jsonl path for --distill-session")
    ap.add_argument("--live", action="store_true", help="Actually execute GraphQL mutations (or set MANA_ECHO_LIVE=1)")
    ap.add_argument("--dry-run", action="store_true", help="Force dry-run even if MANA_ECHO_LIVE=1")
    args = ap.parse_args()

    if args.self_test:
        run_selftest()
        return
    if args.distill_session:
        out_path = args.out or args.distill_session.with_suffix(".events.jsonl")
        new_off, events = distill_session_jsonl(args.distill_session.resolve(), out_path.resolve(), 0)
        print(json.dumps({"offset": new_off, "count": len(events), "out": str(out_path)}, ensure_ascii=False))
        return
    if args.sync_session:
        sfile = args.sync_session.resolve()
        rdir = args.repo.resolve() if args.repo else None
        live = is_live_enabled(args.live, args.dry_run)
        res = safe_sync_session(sfile, repo_dir=rdir, dry_run=not live)
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return
    if args.sync_mana:
        rdir = args.sync_mana.resolve()
        live = is_live_enabled(args.live, args.dry_run)
        res = safe_sync_mana_run(rdir, rdir / "echo-state.json", dry_run=not live)
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return
    if args.watch_repo:
        live = is_live_enabled(args.live, args.dry_run)
        watch_repo(args.watch_repo.resolve(), live=live)
        return
    ap.print_help()


if __name__ == "__main__":
    main()
