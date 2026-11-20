#!/usr/bin/env python3
"""decisions.tsv → state.decision_log 强制同源工具（Issue #108 B 项）。

decisions.tsv 是决策轨迹的权威源（§1 run 第 3 步起逐决策追加）；state.json 的
decision_log 是投影，两者不同源 = 决策轨迹静默不一致（假绿）。本工具以 tsv 为准
重建 state.decision_log：

  python3 scripts/mana-sync-decisions.py <run_dir>          # 同步（重建 + 原子写回）
  python3 scripts/mana-sync-decisions.py <run_dir> --check  # 只比对，不写盘

退出码：0 一致或已同步 | 1 --check 发现不一致 | 2 输入非法。
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


def rows_equal(a: list[dict], b: list[dict]) -> bool:
    return a == b


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
    if rows_equal(before, rows):
        print(f"OK: decision_log 与 decisions.tsv 一致（{len(rows)} 条）")
        return 0

    diff = abs(len(before) - len(rows))
    if args.check:
        print(
            f"FAIL: state.decision_log（{len(before)} 条）≠ decisions.tsv（{len(rows)} 条），"
            f"差异 {diff} 条 —— 跑 python3 scripts/mana-sync-decisions.py {args.run_dir} 同步"
        )
        return 1

    check_lanes(st, state_path)
    st["decision_log"] = rows
    atomic_write_state(state_path, st)
    print(f"OK: 已同步 decision_log {len(before)} → {len(rows)} 条（原子写回 {state_path}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
