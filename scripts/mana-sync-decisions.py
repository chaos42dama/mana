#!/usr/bin/env python3
"""decisions.tsv → state.decision_log 强制同源工具（Issue #108 B 项）。

decisions.tsv 是决策轨迹的权威源（§1 run 第 3 步起逐决策追加）；state.json 的
decision_log 是投影，两者不同源 = 决策轨迹静默不一致（假绿）。本工具以 tsv 为准
重建 state.decision_log：

  python3 scripts/mana-sync-decisions.py <run_dir>          # 同步（重建 + 原子写回）
  python3 scripts/mana-sync-decisions.py <run_dir> --check  # 只比对，不写盘

退出码：0 条数一致（内容漂移仅提示；同步模式会以 tsv 为准重写）| 1 --check 发现条数不一致 | 2 输入非法。

判据为什么是条数而非内容全等：decisions.tsv 是 6 列单行格式，多行 evidence 会被压成
`⏎`，state 条目还可能带 tsv 表达不了的键（如 retry_mode）。故「内容全等」对历史 run 恒假；
能机器判定的不变量是**决策条数一致**（漏写/多写一条），内容以 tsv 为准单向收敛。
"""
from __future__ import annotations

import argparse
import contextlib
import csv
import json
import os
import sys
import tempfile

TSV_COLUMNS = ["time", "phase", "decision", "reason", "evidence", "result"]


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    raise SystemExit(2)


def load_tsv_rows(tsv_path: str) -> list[dict]:
    """读 6 列 TSV（首行表头），数据行恰好 6 列，否则判输入非法（rc=2）。

    注意：这里用严格口径（每行恰好 6 列），与 echo-discussion-sink.parse_decisions_tsv
    的宽容跳过口径不同——本工具是写 state 的强制门，坏行必须挡下而不是跳过。
    """
    if not os.path.isfile(tsv_path):
        fail(f"{tsv_path} 不存在（decisions.tsv 是权威源，缺失即无法同源）")
    rows: list[list[str]] = []
    try:
        with open(tsv_path, encoding="utf-8", newline="") as fh:
            rows = list(csv.reader(fh, delimiter="\t"))
    except OSError as exc:
        fail(f"{tsv_path} 无法读取：{exc}")
    if not rows or [c.strip() for c in rows[0][:6]] != TSV_COLUMNS:
        fail(f"{tsv_path} 表头必须是 6 列 {'<TAB>'.join(TSV_COLUMNS)}")
    out: list[dict] = []
    for i, row in enumerate(rows[1:], start=2):
        if not any(cell.strip() for cell in row):
            continue  # 全空行跳过
        if len(row) != 6:
            fail(f"{tsv_path} 第 {i} 行是 {len(row)} 列，须恰好 6 列（TAB 分隔）")
        out.append(dict(zip(TSV_COLUMNS, (c.strip() for c in row), strict=True)))
    return out


def append_correction(rows: list[dict]) -> list[dict]:
    """correction 行映射（Issue #108 伪代码）：phase == "correction" 时加注字段。"""
    for row in rows:
        if row.get("phase") == "correction":
            row["observed_claim"] = row.get("decision", "")
            row["correction"] = row.get("reason", "")
            row["source"] = row.get("evidence", "")
    return rows


def load_state(state_path: str) -> dict:
    if not os.path.isfile(state_path):
        fail(f"{state_path} 不存在（<run_dir>/state.json）")
    try:
        with open(state_path, encoding="utf-8") as fh:
            return json.load(fh)
    except OSError as exc:
        fail(f"{state_path} 无法读取：{exc}")
    except json.JSONDecodeError as exc:
        fail(f"{state_path} 不是合法 JSON：{exc}")
    return {}  # 不可达；安抚类型检查


def check_lanes(st: dict, state_path: str) -> None:
    """写盘前断言：lanes 非空（run 骨架未建 = 拒绝写 state）。"""
    if not st.get("lanes"):
        fail(f"{state_path} 缺 lanes 或 lanes 为空 —— 拒绝写 state")


def content_drift(before: list[dict], rows: list[dict]) -> int:
    """条数相同时，逐条比对 6 列投影的差异条数（仅用于提示，不判败）。

    为什么条数是唯一可强制的判据：decisions.tsv 是 6 列单行格式，多行 evidence 被压成
    `⏎`、state 条目还可能带 tsv 表达不了的键（如 retry_mode）。因此「内容全等」对历史
    run 恒假——真正能机器判定的一致性是**条数一致**（漏写/多写一条决策）。
    """
    cols = TSV_COLUMNS
    return sum(
        1
        for old, new in zip(before, rows)
        if {k: old.get(k, "") for k in cols} != {k: new.get(k, "") for k in cols}
    )


def atomic_write_state(state_path: str, st: dict) -> None:
    """tempfile 同目录落盘 + os.replace 原子替换，禁直接覆盖写。"""
    d = os.path.dirname(state_path) or "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".state.json.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(st, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp, state_path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def main() -> int:
    ap = argparse.ArgumentParser(
        prog="mana-sync-decisions.py",
        description=(
            "以 decisions.tsv 为权威源重建 <run_dir>/state.json 的 decision_log（Issue #108 B 项）。"
        ),
    )
    ap.add_argument("run_dir", help="run 目录（内含 decisions.tsv 与 state.json）")
    ap.add_argument(
        "--check",
        action="store_true",
        help="只比对不写盘：不一致时 exit 1 并点名差异条数",
    )
    args = ap.parse_args()

    tsv_path = os.path.join(args.run_dir, "decisions.tsv")
    state_path = os.path.join(args.run_dir, "state.json")

    rows = append_correction(load_tsv_rows(tsv_path))
    st = load_state(state_path)

    before = st.get("decision_log") or []
    drift = content_drift(before, rows) if len(before) == len(rows) else 0

    if len(before) == len(rows):
        note = f"，{drift} 行内容与 tsv 不同（tsv 为权威源）" if drift else ""
        print(f"OK: decision_log 与 decisions.tsv 条数一致（{len(rows)} 条）{note}")
        if not drift:
            return 0

    if args.check:
        if len(before) != len(rows):
            print(
                f"FAIL: state.decision_log（{len(before)} 条）≠ decisions.tsv（{len(rows)} 条），"
                f"差异 {abs(len(before) - len(rows))} 条 —— 跑 python3 scripts/mana-sync-decisions.py {args.run_dir} 同步"
            )
            return 1
        print(f"OK(--check): 条数一致，{drift} 行内容漂移留待同步（不判败：tsv 无法表达多行/额外键）")
        return 0

    check_lanes(st, state_path)
    # 保留 tsv 表达不了的键（如 retry_mode）：按位置从旧条目带过来，其余以 tsv 为准。
    merged: list[dict] = []
    for i, row in enumerate(rows):
        carried = {}
        if i < len(before) and isinstance(before[i], dict):
            carried = {k: v for k, v in before[i].items() if k not in TSV_COLUMNS}
        merged.append({**carried, **row})
    st["decision_log"] = merged
    atomic_write_state(state_path, st)
    print(f"OK: 已同步 decision_log {len(before)} → {len(rows)} 条（原子写回 {state_path}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
