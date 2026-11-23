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

# 解析水位里保留的最近回合数（Issue #128）：更早回合的楼层已建、状态键不再变化，
# 丢弃它们只影响"更新旧楼层"资格，幂等由 sink 的 turn_comments 承担。
PERSISTED_TURNS_WINDOW = 200
# 水位文件里回合文本的字符预算上限（防止单个超长会话把水位文件撑爆）。
PERSISTED_TURNS_MAX_CHARS = 256 * 1024

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


def _new_session_state(session_id: str, session_path: str = "") -> dict[str, Any]:
    """新建会话解析水位状态（增量解析用；Issue #128）。"""
    return {
        "offset": 0,
        "line_index": 0,
        "session_id": session_id,
        "session_path": session_path,
        "cwd": None,
        "title": None,
        "model": None,
        "started_at": None,
        "has_mana_command": False,
        "turns": [],
        "_run_ids": set(),
    }


def _session_info(state: dict[str, Any]) -> dict[str, Any]:
    """把解析水位状态投影成对外 info 形状（与旧的全量解析一致）。"""
    return {
        "session_id": state["session_id"],
        "session_path": state["session_path"],
        "cwd": state["cwd"],
        "title": state["title"],
        "model": state["model"],
        "started_at": state["started_at"],
        "turns": state["turns"],
        "has_mana_command": state["has_mana_command"],
        "referenced_run_ids": sorted(state["_run_ids"]),
    }


def parse_session_jsonl(
    session_path: Path,
    state: dict[str, Any] | None = None,
    max_bytes: int | None = None,
) -> dict[str, Any]:
    """解析 omp/pi 会话 JSONL，提取 session_id、cwd、model、以及所有用户指令回合（含是否命中 /mana）。

    增量语义（Issue #128）：
    - state=None → 一次性全量解析（CLI 单次调用、离线自检）。
    - state=dict → 只消费 state["offset"] 之后的新增字节并就地更新水位
      （offset / line_index / turns / 元信息），供下一轮续读；max_bytes 限制本次新增
      消费字节数（单 tick 解析预算），超限提前收尾、下一轮从断点继续。
    """
    if state is None:
        state = _new_session_state(
            extract_session_id_from_stem(session_path), str(session_path)
        )
    info = state  # 就地更新：turns 列表与水位共享同一份状态
    if not session_path.exists():
        return _session_info(state)

    try:
        size = session_path.stat().st_size
    except OSError:
        return _session_info(state)
    if size < state["offset"]:
        # 文件被截断或轮转：丢弃水位，从头重解析
        fresh = _new_session_state(
            extract_session_id_from_stem(session_path), str(session_path)
        )
        state.clear()
        state.update(fresh)

    want = size - state["offset"]
    if max_bytes is not None:
        want = min(want, max(0, int(max_bytes)))
    if want <= 0:
        return _session_info(state)

    try:
        with session_path.open("rb") as fh:
            fh.seek(state["offset"])
            buf = b""
            eof = False
            # 读到「累计 want 字节以上且含换行」或 EOF 为止：必须能看到预算边界之后的换行，
            # 否则预算小于单行长度时会永远读不满同一行（零进展死循环）。
            while True:
                block = fh.read(262144)
                if not block:
                    eof = True
                    break
                buf += block
                if len(buf) >= want and b"\n" in buf:
                    break
    except OSError:
        return _session_info(state)
    if not buf:
        return _session_info(state)

    # 行边界：预算内的完整行照常消费；预算内没有完整行时，吃掉第一条跨预算的行（保证推进）。
    nl_positions: list[int] = []
    scan = 0
    while True:
        idx = buf.find(b"\n", scan)
        if idx < 0:
            break
        nl_positions.append(idx)
        scan = idx + 1

    within = [p + 1 for p in nl_positions if p + 1 <= want]
    if within:
        consumed = within[-1]
        lines = buf[:consumed].decode("utf-8", errors="replace").split("\n")
        if lines and lines[-1] == "":
            lines.pop()
    elif nl_positions:
        # 单行超过预算：吃掉第一条跨预算的行，保证本轮有进展（下一轮从其后继续）
        consumed = nl_positions[0] + 1
        lines = buf[:consumed].decode("utf-8", errors="replace").split("\n")
        if lines and lines[-1] == "":
            lines.pop()
    else:
        # 窗口内没有任何换行：只有 EOF 时的最后一行（无换行）才可能是完整记录
        if not eof:
            return _session_info(state)
        candidate = buf.decode("utf-8", errors="replace").strip()
        try:
            json.loads(candidate)
        except Exception:
            return _session_info(state)
        consumed = len(buf)
        lines = [candidate]

    if eof:
        tail = buf[consumed:].decode("utf-8", errors="replace").strip()
        if tail:
            # 末尾无换行的残留：仅当它本身是合法 JSON（完整记录）时才消费
            try:
                json.loads(tail)
            except Exception:
                tail = ""
            if tail:
                lines.append(tail)
                consumed = len(buf)

    state["offset"] += consumed
    current_turn: dict[str, Any] | None = info["turns"][-1] if info["turns"] else None
    run_id_set: set[str] = state["_run_ids"]

    for idx, raw in enumerate(lines, start=state["line_index"]):
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

    state["line_index"] += len(lines)
    state["_run_ids"] = run_id_set
    if len(state["turns"]) > PERSISTED_TURNS_WINDOW:
        del state["turns"][:-PERSISTED_TURNS_WINDOW]
    return _session_info(state)


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


def evidence_to_text(evidence: Any) -> str:
    """把 evidence 规整成纯文本。

    `acceptance_output` / `verdict` 在 state.json 里可能是 dict（检查名 → 结果），
    旧实现直接 `.strip()` 会抛 AttributeError 并让整条 lane 同步失败——线上写入因此全断。
    """
    if evidence is None:
        return ""
    if isinstance(evidence, str):
        return evidence.strip()
    if isinstance(evidence, dict):
        parts = []
        for key, value in evidence.items():
            if isinstance(value, (dict, list)):
                value = json.dumps(value, ensure_ascii=False)
            parts.append(f"{key}: {value}")
        return "\n".join(parts).strip()
    if isinstance(evidence, (list, tuple)):
        return "\n".join(str(v) for v in evidence).strip()
    return str(evidence).strip()


def format_step_comment(
    seq: int,
    phase: str,
    title: str,
    summary: str,
    tool_trace: list[str] | None = None,
    evidence: Any = None,
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
    evidence_text = evidence_to_text(evidence)
    if evidence_text:
        lines.extend(
            [
                "",
                "<details><summary>📎 验证 / 反射证据片段</summary>",
                "",
                "```text",
                redact(evidence_text[:3000]),
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
        # 立即落盘 discussion_id：建帖之后的任何异常都不得让 id 丢失
        # （丢失 ⇒ 下一 tick 重复建帖，线上可见的重复帖）。
        sink.save()

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


def parse_state_path(repo_dir: Path, session_key: str) -> Path:
    """会话解析水位文件路径：`<repo>/.mana/echo-parse/<session_key>.json`。

    与 Discussion 状态（`.mana/echo-sessions/<id>.json`）分目录存放，避免互相污染；
    同一会话文件始终命中同一份水位（key 取 session 记录里的 id，回退到文件名推导的 id）。
    """
    return repo_dir / ".mana" / "echo-parse" / f"{session_key}.json"


def load_parse_state(repo_dir: Path, session_id: str) -> dict[str, Any]:
    """读取上次解析水位；不存在或损坏则退化为空水位（等价全量解析）。"""
    state = _new_session_state(session_id)
    path = parse_state_path(repo_dir, session_id)
    if not path.is_file():
        return state
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return state
    if not isinstance(data, dict):
        return state
    for key in ("offset", "line_index"):
        try:
            state[key] = int(data.get(key) or 0)
        except Exception:
            state[key] = 0
    for key in ("session_id", "cwd", "title", "model", "started_at"):
        if data.get(key) is not None:
            state[key] = data[key]
    state["has_mana_command"] = bool(data.get("has_mana_command"))
    state["turns"] = data.get("turns") or []
    state["_run_ids"] = set(data.get("_run_ids") or [])
    return state


def save_parse_state(repo_dir: Path, session_key: str, state: dict[str, Any]) -> None:
    """落盘解析水位（失败不抛：水位丢失只退化为全量解析，不阻断主流程）。

    只保留"仍可能被更新"的最近回合：更早回合的楼层已建、状态键不再变化，
    丢弃它们只影响"更新旧楼层"的资格，不影响幂等（幂等由 sink 的 turn_comments 承担）。
    """
    path = parse_state_path(repo_dir, session_key)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        turns = list(state.get("turns") or [])
        turns = turns[-PERSISTED_TURNS_WINDOW:]
        # 按字符预算再裁一次，避免单个长会话的水位文件无限膨胀
        budget = PERSISTED_TURNS_MAX_CHARS
        while turns:
            size = sum(len(json.dumps(t, ensure_ascii=False)) for t in turns)
            if size <= budget:
                break
            turns.pop(0)
        data = {
            "offset": int(state.get("offset") or 0),
            "line_index": int(state.get("line_index") or 0),
            "session_id": state.get("session_id"),
            "cwd": state.get("cwd"),
            "title": state.get("title"),
            "model": state.get("model"),
            "started_at": state.get("started_at"),
            "has_mana_command": bool(state.get("has_mana_command")),
            "turns": turns,
            "_run_ids": sorted(state.get("_run_ids") or []),
        }
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)
    except Exception:
        pass


def read_session_meta(session_path: Path) -> dict[str, Any]:
    """读取会话头部的 `session` 记录（cwd / id），**只扫前 256KiB**，命中即停。

    会话记录在文件开头（omp/pi 均为首两条之一），故限定扫描窗口，避免尾部大文件被整读。
    扫不到就返回空 meta（调用方退化为用 stem 推导的 id + 调用方给的 repo_dir）。
    """
    meta: dict[str, Any] = {"session_id": None, "cwd": None}
    scanned = 0
    try:
        with session_path.open("rb") as fh:
            carry = b""
            while scanned < 256 * 1024:
                block = fh.read(65536)
                if not block:
                    break
                scanned += len(block)
                buf = carry + block
                lines = buf.split(b"\n")
                carry = lines.pop()
                for raw in lines:
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        obj = json.loads(raw.decode("utf-8", errors="replace"))
                    except Exception:
                        continue
                    if obj.get("type") == "session":
                        if obj.get("id"):
                            meta["session_id"] = str(obj["id"])
                        if obj.get("cwd"):
                            meta["cwd"] = str(obj["cwd"])
                        return meta
    except OSError:
        return meta
    return meta


def sync_session(
    session_path: Path,
    state_file: Path | None = None,
    repo_dir: Path | None = None,
    dry_run: bool = True,
    max_bytes: int | None = None,
) -> list[dict[str, Any]]:
    """按 Session 粒度同步：
    1 个 session (.jsonl) = 1 个 Discussion 主帖；
    每当在 session 中执行 `/mana ...` 指令（无论 recall/how/why/run），立即建帖或追加 `[session:turn]` 楼层；
    若该 session 关联了 `.mana/<run-id>`，则将该 run 的 Lane 状态跃迁与 `decisions.tsv` 一并同步至同一 Discussion；
    当用户 `/new` 或 `/q` 重启进程产生新 session `.jsonl` 时，因 `session_id` 不同，自动创建对应的新的 Discussion！

    解析走**字节偏移增量**（水位落盘 `<repo>/.mana/echo-sessions/<session_id>.parse.json`）：
    单次只消费新增字节，max_bytes 为本次解析预算上限（超限留到下一轮）。
    """
    ops, _ = _sync_session_impl(session_path, state_file, repo_dir, dry_run, max_bytes)
    return ops


def _sync_session_impl(
    session_path: Path,
    state_file: Path | None,
    repo_dir: Path | None,
    dry_run: bool,
    max_bytes: int | None,
) -> tuple[list[dict[str, Any]], int]:
    """返回 (ops, 本次新增消费字节数)。"""
    import fcntl

    meta = read_session_meta(session_path)
    if repo_dir is not None:
        resolved_repo = repo_dir
    elif meta.get("cwd") and Path(meta["cwd"]).is_dir():
        resolved_repo = Path(meta["cwd"])
    else:
        resolved_repo = session_path.parent

    session_key = meta.get("session_id") or extract_session_id_from_stem(session_path)
    pstate = parse_state_path(resolved_repo, session_key)
    consumed = 0
    try:
        pstate.parent.mkdir(parents=True, exist_ok=True)
    except Exception:
        return [], 0
    with pstate.with_suffix(".lock").open("a+", encoding="utf-8") as parse_lock:
        try:
            fcntl.flock(parse_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return [], 0
        state = load_parse_state(resolved_repo, session_key)
        before_offset = int(state.get("offset") or 0)
        sess_info = parse_session_jsonl(session_path, state=state, max_bytes=max_bytes)
        consumed = int(state.get("offset") or 0) - before_offset
        if consumed > 0:
            save_parse_state(resolved_repo, session_key, state)

    if not sess_info["has_mana_command"]:
        return [], consumed

    target_state_file = state_file or (
        resolved_repo / ".mana" / "echo-sessions" / f"{sess_info['session_id']}.json"
    )
    target_state_file.parent.mkdir(parents=True, exist_ok=True)
    lock_file = target_state_file.with_suffix(".lock")
    with lock_file.open("a+", encoding="utf-8") as lock_fh:
        try:
            fcntl.flock(lock_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return [], consumed
        return (
            _sync_session_locked(
                sess_info, session_path, resolved_repo, target_state_file, dry_run=dry_run
            ),
            consumed,
        )


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
        # 立即落盘 discussion_id：建帖之后的任何异常都不得让 id 丢失（丢失 ⇒ 重复建帖）
        sink.save()

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

    # 1c. Issue #128：增量解析等价性 + 单 tick 预算 + live 门控
    with tempfile.TemporaryDirectory() as tmp:
        sess = Path(tmp) / "2026-10-23T04-00-00-000Z_01c00001-0000-0000-0000-000000000001.jsonl"
        records = [
            {"type": "session", "id": "01c00001-0000-0000-0000-000000000001", "cwd": tmp},
            {
                "type": "message",
                "id": "m1",
                "message": {"role": "user", "content": [{"type": "text", "text": "/mana recall #95"}]},
            },
            {
                "type": "message",
                "id": "m2",
                "message": {
                    "role": "assistant",
                    "usage": {"totalTokens": 42},
                    "content": [{"type": "toolCall", "name": "bash", "arguments": {"command": "ls"}}],
                },
            },
        ]
        sess.write_text("\n".join(json.dumps(r) for r in records) + "\n", encoding="utf-8")

        # 全量解析基准
        full = parse_session_jsonl(sess)
        assert full["has_mana_command"] is True, full
        assert len(full["turns"]) == 1, full
        full_turn_ids = [t["id"] for t in full["turns"]]
        full_trace_len = len(full["turns"][0]["tool_trace"])

        # 增量解析：分多轮消费，结果必须与全量一致
        st = _new_session_state(extract_session_id_from_stem(sess), str(sess))
        rounds = 0
        while st["offset"] < sess.stat().st_size and rounds < 50:
            parse_session_jsonl(sess, state=st, max_bytes=64)
            rounds += 1
        inc = _session_info(st)
        assert inc["has_mana_command"] is True, inc
        assert [t["id"] for t in inc["turns"]] == full_turn_ids, (inc["turns"], full["turns"])
        assert len(inc["turns"][0]["tool_trace"]) == full_trace_len, inc["turns"][0]["tool_trace"]
        assert inc["session_id"] == full["session_id"], inc
        assert rounds > 1, "分轮消费必须真的发生多轮（否则测不到增量路径）"

        # 单 tick 预算：max_bytes 限制本轮消费；但必须保证有进展（不因单行超预算而死循环）
        st2 = _new_session_state(extract_session_id_from_stem(sess), str(sess))
        parse_session_jsonl(sess, state=st2, max_bytes=32)
        assert st2["offset"] > 0, "预算受限的一轮也必须推进水位（不得零进展）"
        assert st2["offset"] < sess.stat().st_size, "预算应让本轮无法读完整个文件"
        rounds2 = 1
        while st2["offset"] < sess.stat().st_size and rounds2 < 50:
            parse_session_jsonl(sess, state=st2, max_bytes=32)
            rounds2 += 1
        assert st2["offset"] == sess.stat().st_size, (st2["offset"], sess.stat().st_size)
        assert [t["id"] for t in _session_info(st2)["turns"]] == full_turn_ids, "预算分轮结果须与全量一致"

        # 水位落盘/读回：偏移与回合必须可恢复
        repo = Path(tmp) / "repo"
        repo.mkdir()
        save_parse_state(repo, extract_session_id_from_stem(sess), st)
        st_loaded = load_parse_state(repo, extract_session_id_from_stem(sess))
        assert st_loaded["offset"] == st["offset"], (st_loaded["offset"], st["offset"])
        assert len(st_loaded["turns"]) == len(st["turns"]), st_loaded["turns"]

        # live 门控：live=False 时 watch_repo 立即返回，不进入轮询（Issue #128 方案 A）
        import time as _time

        t0 = _time.time()
        watch_repo(repo, live=False)
        assert _time.time() - t0 < 1.0, "live=False 时 watch_repo 必须立即返回"

    # 1d. Issue #131：`acceptance_output` / `verdict` 可能是 dict（检查名→结果），
    # 旧实现直接 `.strip()` 抛 AttributeError → 异常落在「建帖之后、落盘之前」→
    # 每 tick 重复建帖且从不记住 id（线上可见的重复帖）。
    assert evidence_to_text(None) == "", "None → 空文本"
    assert evidence_to_text("  x  ") == "x", "字符串 → strip"
    assert evidence_to_text({"a": "1", "b": "2"}) == "a: 1\nb: 2", "dict → 键值行"
    assert evidence_to_text({"a": {"n": 1}}) == 'a: {"n": 1}', "dict 嵌套 → JSON 序列化"
    assert evidence_to_text(["x", "y"]) == "x\ny", "list → 每行一项"
    assert evidence_to_text(42) == "42", "数字 → 字符串"
    body = format_step_comment(seq=1, phase="lane:x", title="t", summary="s", evidence={"k": "v"})
    assert "k: v" in body, body

    # 真实回归：run 级同步遇到 dict evidence 必须成功落盘 discussion_id（不重复建帖）
    with tempfile.TemporaryDirectory() as tmp:
        rdir = Path(tmp) / ".mana" / "run-dict-evidence"
        rdir.mkdir(parents=True)
        (rdir / "state.json").write_text(
            json.dumps(
                {
                    "run_id": "run-dict-evidence",
                    "worker_model": "pi",
                    "lanes": [
                        {
                            "id": "lane-1",
                            "status": "landed",
                            "attempt": 1,
                            "acceptance_output": {"全量回归": "ALL-38-rc=0"},
                            "verdict": {"ok": True},
                        }
                    ],
                    "decision_log": [],
                }
            ),
            encoding="utf-8",
        )
        state_file = rdir / "echo-state.json"
        ops = sync_mana_run(rdir, state_file, dry_run=True)
        assert ops, "dict evidence 不得让整条 run 同步失败"
        saved = json.loads(state_file.read_text(encoding="utf-8"))
        assert saved.get("discussion_id"), "同步成功后必须落盘 discussion_id（否则每 tick 重复建帖）"
        assert saved.get("last_error") is None, saved.get("last_error")

    # 1e. Issue #131：echo 产物清理策略——日志与解析水位按保留期过期删除；
    # **Discussion 状态（.mana/echo-sessions/）不得删**（删了会导致同一 session 重复建帖）。
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp) / "repo"
        pdir = repo / ".mana" / "echo-parse"
        sdir = repo / ".mana" / "echo-sessions"
        pdir.mkdir(parents=True)
        sdir.mkdir(parents=True)
        old_p = pdir / "old.json"
        new_p = pdir / "new.json"
        old_s = sdir / "oldsess.json"
        old_p.write_text("{}", encoding="utf-8")
        new_p.write_text("{}", encoding="utf-8")
        old_s.write_text("{}", encoding="utf-8")
        stale = time.time() - 30 * 86400
        for p in (old_p, old_s):
            os.utime(p, (stale, stale))
        os.utime(new_p, None)  # 新文件不删

        log_dir = Path(tmp) / "logs"
        log_dir.mkdir()
        old_log = log_dir / "old.log"
        new_log = log_dir / "new.log"
        old_log.write_text("x", encoding="utf-8")
        new_log.write_text("x", encoding="utf-8")
        os.utime(old_log, (stale, stale))
        os.utime(new_log, None)

        os.environ["MANA_ECHO_LOG_DIR"] = str(log_dir)
        try:
            counts = prune_echo_artifacts(repo_dir=repo, retention_days=14)
        finally:
            del os.environ["MANA_ECHO_LOG_DIR"]
        assert counts["logs"] == 1, counts
        assert counts["parse_state"] == 1, counts
        assert not old_log.exists(), "过期日志须删除"
        assert not old_p.exists(), "过期解析水位须删除"
        assert new_log.exists(), "未过期日志须保留"
        assert new_p.exists(), "未过期解析水位须保留"
        assert old_s.exists(), "Discussion 状态（幂等依据）不得被清理"

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


def watch_repo(
    repo_dir: Path,
    live: bool,
    interval_sec: float = 3.0,
    max_idle_sec: float = 1800.0,
) -> None:
    """单实例后台实时尾随守护：每 3s 扫描本仓活跃 session JSONL 与 repo/.mana/*/state.json，秒级反射到 echo 讨论区。

    Issue #128 的三道闸门：
    1. **live 门控**：`live=False`（未设 `MANA_ECHO_LIVE`）时直接返回——dry-run 守护只写本地
       假 id（`D_dryrun_*`），零线上效果，却要付全额解析 CPU。
    2. **单 tick 解析预算**：每轮最多解析 `tick_budget_bytes` 字节（超出的留到下一轮），
       并对单个超大文件设 `max_file_bytes` 上限——畸形大文件不得吃满单核。
    3. **增量解析**：session JSONL 按字节偏移续读（见 `parse_session_jsonl`），CPU 与新增字节量
       成正比，与文件总大小解耦。
    """
    if not live:
        return

    import fcntl
    import hashlib

    tick_budget_bytes = int(os.environ.get("MANA_ECHO_TICK_BUDGET_BYTES", 8 * 1024 * 1024))
    max_file_bytes = int(os.environ.get("MANA_ECHO_MAX_FILE_BYTES", 256 * 1024 * 1024))

    mana_root = repo_dir / ".mana"
    repo_hash = hashlib.sha256(str(repo_dir.resolve()).encode("utf-8")).hexdigest()[:16]
    lock_path = Path(f"/tmp/mana-echo-watch-{repo_hash}.lock")
    with lock_path.open("a+", encoding="utf-8") as lock_fh:
        try:
            fcntl.flock(lock_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        last_active = time.time()
        last_prune = 0.0
        prune_interval = float(os.environ.get("MANA_ECHO_PRUNE_INTERVAL_SEC", 3600))
        while True:
            now = time.time()
            has_recent = False
            budget_left = tick_budget_bytes
            # 0) 周期性清理 echo 产物（默认每小时一次；日志与解析水位按保留期过期删除）
            if now - last_prune >= prune_interval:
                last_prune = now
                try:
                    prune_echo_artifacts(repo_dir=repo_dir)
                except Exception:
                    pass
            # 1) 优先按 Session 粒度扫描当前仓库的 omp/pi 会话 JSONL
            for sess_file in discover_repo_sessions(repo_dir, max_age_sec=1200.0):
                try:
                    st = sess_file.stat()
                    if (now - st.st_mtime) <= 1800:
                        has_recent = True
                except OSError:
                    continue
                if st.st_size > max_file_bytes:
                    continue  # 超大文件跳过（不解析、不阻塞其余文件）
                if budget_left <= 0:
                    break
                try:
                    _, consumed = _sync_session_impl(
                        sess_file,
                        None,
                        repo_dir,
                        dry_run=not live,
                        max_bytes=min(budget_left, max_file_bytes),
                    )
                except Exception as exc:  # 绝不因单个 session 失败而终止守护
                    print(
                        f"echo-discussion-sink: WARN: session 同步失败（已降级忽略）: "
                        f"{redact(str(exc))}",
                        file=sys.stderr,
                    )
                    continue
                budget_left -= consumed

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


def echo_log_dir() -> Path:
    """echo 守护日志目录：`$MANA_ECHO_LOG_DIR` 或默认 `~/.omp/agent/state/mana/echo`。"""
    raw = os.environ.get("MANA_ECHO_LOG_DIR", "").strip()
    if raw:
        return Path(raw).expanduser()
    return Path.home() / ".omp" / "agent" / "state" / "mana" / "echo"


# 清理策略（Issue #131）：echo 产物按「保留天数」过期删除，默认 14 天。
# - 日志：只留最近 N 天；单文件另有 1MiB 上限轮转（attach_log）。
# - 解析水位 `.mana/echo-parse/`：删了就退化为全量解析，不影响正确性。
# - Discussion 状态 `.mana/echo-sessions/`：**不删**——它是"同一 session 复用同一帖"的
#   幂等依据；删掉会导致同一 session 被重新建帖（线上重复帖，见 #131）。
PRUNE_RETENTION_DAYS = 14
PRUNE_TARGETS = ("logs", "parse_state")


def _prune_files_older_than(paths: list[Path], cutoff: float) -> int:
    removed = 0
    for p in paths:
        try:
            if p.is_file() and p.stat().st_mtime < cutoff:
                p.unlink()
                removed += 1
        except OSError:
            continue
    return removed


def prune_echo_artifacts(
    repo_dir: Path | None = None,
    retention_days: int | None = None,
    targets: tuple[str, ...] = PRUNE_TARGETS,
) -> dict[str, int]:
    """按保留期清理 echo 产物，返回各目标删除计数。

    - `logs`：echo 守护 stderr 日志目录（`$MANA_ECHO_LOG_DIR`）。
    - `parse_state`：仓内 `.mana/echo-parse/` 解析水位（丢了只退化为全量解析）。
    - `session_state`（`.mana/echo-sessions/`）**不在清理范围内**：它是幂等依据，
      删了会导致同一 session 重复建帖。
    """
    days = retention_days if retention_days is not None else PRUNE_RETENTION_DAYS
    cutoff = time.time() - max(0, days) * 86400
    counts = {"logs": 0, "parse_state": 0}
    if "logs" in targets:
        d = echo_log_dir()
        if d.is_dir():
            try:
                counts["logs"] = _prune_files_older_than(list(d.glob("*.log")), cutoff)
            except OSError:
                pass
    if "parse_state" in targets and repo_dir is not None:
        pdir = repo_dir / ".mana" / "echo-parse"
        if pdir.is_dir():
            try:
                counts["parse_state"] = _prune_files_older_than(list(pdir.glob("*.json")), cutoff)
            except OSError:
                pass
    return counts


def attach_log(repo_hint: str) -> Path | None:
    """把本进程的 stderr 落盘到 `<log-dir>/<repo-slug>.log`（追加，带大小上限）。

    背景（Issue #131）：守护由 preflight / heartbeat / mana-compact 三处拉起，三处都用
    `>/dev/null 2>&1` 丢弃 stderr —— 同步异常因此完全静默，线上重复建帖无人察觉。
    这里在**脚本内部**接管自己的 stderr（dup2），不依赖调用方是否丢弃。
    """
    try:
        d = echo_log_dir()
        d.mkdir(parents=True, exist_ok=True)
        slug = repo_hint.strip("/").replace("/", "-").replace(" ", "_") or "unknown"
        path = d / f"{slug}.log"
        max_bytes = 1 * 1024 * 1024
        try:
            if path.exists() and path.stat().st_size > max_bytes:
                path.write_text("", encoding="utf-8")  # 超限即轮转（只留最新）
        except OSError:
            pass
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        os.dup2(fd, 2)  # 接管 stderr：此后所有 print(..., file=sys.stderr) 都进日志
        os.close(fd)
        return path
    except Exception:
        return None


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
    ap.add_argument(
        "--prune",
        action="store_true",
        help="只做清理：按保留期删除过期 echo 日志与解析水位（不联网、不写 Discussion）",
    )
    ap.add_argument(
        "--prune-days",
        type=int,
        default=None,
        help=f"清理保留天数（默认 {PRUNE_RETENTION_DAYS}）",
    )
    args = ap.parse_args()

    if args.self_test:
        run_selftest()
        return
    if args.prune:
        counts = prune_echo_artifacts(
            repo_dir=args.repo.resolve() if args.repo else None,
            retention_days=args.prune_days,
        )
        print(json.dumps({"ok": True, "pruned": counts}, ensure_ascii=False))
        return
    if args.distill_session:
        out_path = args.out or args.distill_session.with_suffix(".events.jsonl")
        new_off, events = distill_session_jsonl(args.distill_session.resolve(), out_path.resolve(), 0)
        print(json.dumps({"offset": new_off, "count": len(events), "out": str(out_path)}, ensure_ascii=False))
        return
    # 后台/一次性调用的 stderr 落盘（守护被三处以 >/dev/null 2>&1 拉起，异常不得静默）
    _log_hint = str(
        args.watch_repo
        or args.repo
        or (args.sync_mana.parent.parent if args.sync_mana else "")
        or (args.sync_session.parent if args.sync_session else "")
    )
    attach_log(_log_hint)
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
