#!/usr/bin/env python3
"""echo-discussion-sink.py — 将 mana 的执行过程、Lane 状态跃迁与反射监察事件
映射为 GitHub Discussions (41490/ipi · categories/echo) 的讨论帖与分步回复（方案 A）。

特点:
1. 零第三方依赖 (Python 3.10+ 标准库 + `gh api graphql`)
2. 方案 A 粒度: 1 个 run = 1 个 `echo` 主帖动态看板 (`createDiscussion` + `updateDiscussion`);
   仅按「Lane 状态跃迁 (`planned -> running -> verified/blocked/reclaimed`) + `decisions.tsv` / `decision_log`
   反射与验收事件」追加回复楼层 (`addDiscussionComment`, Lane 内事件用 `replyToId` 挂在该 Lane 顶层评论下),
   不按每个细碎回合刷楼; 细碎工具调用旁路蒸馏至 `lanes/<lane-id>.events.jsonl` 并折叠进 `<details>`。
3. 门控与降级: 通过 `MANA_ECHO_LIVE=1` (或 `--live`) 触发线上写入 `41490/ipi` `echo` 分类;
   未设置或非 `1` 时仅维护本地 `<repo>/.mana/<run-id>/echo-state.json` (dry-run);
   任何网络/限流失败只记日志与 `last_error`、绝不阻断 `mana` 主流程 (exit 0)。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

# 已通过只读 GraphQL 核实的 41490/ipi 常量
DEFAULT_OWNER = "41490"
DEFAULT_REPO = "ipi"
DEFAULT_REPO_ID = "R_kgDOThYpRg"
DEFAULT_ECHO_CATEGORY_ID = "DIC_kwDOThYpRs4DBz3d"  # slug: echo ("Show off something you've made")

SGT = dt.timezone(dt.timedelta(hours=8), name="SGT")

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
                if rc_path.exists() and re.search(r"""^\s*export\s+MANA_ECHO_LIVE=['"]?1['"]?\b""", rc_path.read_text(encoding="utf-8", errors="ignore"), re.M):
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
                    "modelId": obj.get("modelId"),
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


def format_root_body(meta: dict[str, Any], lanes: list[dict[str, Any]] | None = None) -> str:
    lines = [
        f"## 任务看板 · `{meta.get('run_id', '-')}`",
        "",
        f"- **主机 / 引擎**: `{meta.get('host', '-')}` / `{meta.get('engine', 'omp+pi')}`",
        f"- **仓库 / 目录**: `{meta.get('cwd', '-')}`",
        f"- **关联 Issue**: {meta.get('issue_ref', '-')}",
        f"- **状态**: **{meta.get('status', '🔄 running')}**",
        f"- **开始时间**: `{meta.get('started_at', now_sgt_str())}`",
        f"- **更新时间**: `{now_sgt_str()}`",
    ]
    if meta.get("goal"):
        lines.extend(["", "### 目标与契约摘要", "", redact(str(meta["goal"]))])
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
    """持久化每个 run/task 对应的 Discussion ID、步骤序号与已同步水位, 保证幂等。"""

    def __init__(self, path: Path):
        self.path = path
        self.data: dict[str, Any] = {
            "discussion_id": None,
            "discussion_number": None,
            "discussion_url": None,
            "title": None,
            "step_seq": 0,
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


def sync_mana_run(run_dir: Path, state_file: Path, dry_run: bool = True) -> list[dict[str, Any]]:
    """读取 mana 的 .mana/<run-id>/state.json (及可选 decisions.tsv / 会话 JSONL),
    按方案 A 增量映射为 41490/ipi echo 分类下的 1 个主帖 + 每个阶段/决策/状态跃迁 1 条回复。"""
    mana_state = json.loads((run_dir / "state.json").read_text(encoding="utf-8"))
    sink = EchoSinkState(state_file)
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

    title = f"[echo] mana · {run_id} · {status_badge}"
    meta = {
        "run_id": run_id,
        "host": os.uname().nodename,
        "engine": f"omp + {mana_state.get('worker_model', 'pi')}",
        "cwd": str(run_dir.parent.parent),
        "issue_ref": str(mana_state.get("issue") or (mana_state.get("authorization") or {}).get("issue") or "-"),
        "status": status_badge,
        "goal": mana_state.get("goal") or "",
    }
    root_body = format_root_body(meta, lanes)

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

    # 1) Lane 状态跃迁 -> 顶层 lane 锚点或二级回复 (方案 A)
    for ln in lanes:
        lid = str(ln.get("id") or "?")
        lstatus = str(ln.get("status") or "planned")
        lattempt = int(ln.get("attempt") or 1)
        key = f"{lid}:{lstatus}:{lattempt}:{ln.get('head_sha') or ''}"
        if sink.data["synced_lane_states"].get(lid) == key:
            continue
        sink.data["step_seq"] += 1
        seq = sink.data["step_seq"]
        summary = (
            f"Lane `{lid}` 状态跃迁为 **`{lstatus}`** (attempt={lattempt}, "
            f"model=`{ln.get('model') or mana_state.get('worker_model') or '-'}`, "
            f"head_sha=`{ln.get('head_sha') or '-'}`)"
        )
        ev_file = run_dir / "lanes" / f"{lid}.events.jsonl"
        tool_trace = load_lane_tool_trace(ev_file)
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

    # 3) 刷新主帖看板
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

    sink.data["last_error"] = None
    sink.save()
    return ops


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

    print("echo-discussion-sink selftest OK (redact + create + idempotent + nested replyToId + events.jsonl + MANA_ECHO_LIVE gate)")


def watch_repo(repo_dir: Path, live: bool, interval_sec: float = 3.0, max_idle_sec: float = 1800.0) -> None:
    """单实例后台实时尾随守护：每 3s 扫描 repo/.mana/*/state.json，一旦创建或状态/决策更新即秒级反射到 echo 讨论区。"""
    import fcntl
    import hashlib
    import time

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
    ap.add_argument("--sync-mana", type=Path, help="Path to .mana/<run-id> directory")
    ap.add_argument("--watch-repo", type=Path, help="Watch <repo>/.mana/*/state.json in real-time (3s interval)")
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
