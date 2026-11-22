#!/usr/bin/env python3
"""轻量有限状态机求解、不变式检查与双模（Mermaid + ASCII）状态图生成器。

用途：服务 `/mana veri init --formal`、`/mana veri statechart`、`/mana veri maintain --formal`。
零外部依赖（仅 Python 标准库）；输入 JSON 规范（默认存放 `.mana/veri/<target>.spec.json`）：
{
  "name": "mana-run-lock",
  "initial": "IDLE",
  "terminal": ["CLEAN"],
  "states": {
    "IDLE": {"locked": false, "holder": null},
    "LOCKED": {"locked": true, "holder": "owner"},
    "CLEAN": {"locked": false, "holder": null}
  },
  "transitions": [
    {"from": "IDLE", "action": "acquire", "to": "LOCKED"},
    {"from": "LOCKED", "action": "release", "to": "CLEAN"}
  ],
  "invariants": [
    {"name": "locked_has_holder", "expr": "(not locked) or (holder is not None)"}
  ]
}
"""

from __future__ import annotations

import argparse
import ast
import json
import sys
from collections import deque
from pathlib import Path
from typing import Any

ALLOWED_AST_NODES = (
    ast.Expression,
    ast.BoolOp,
    ast.And,
    ast.Or,
    ast.UnaryOp,
    ast.Not,
    ast.USub,
    ast.UAdd,
    ast.BinOp,
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.Mod,
    ast.Compare,
    ast.Eq,
    ast.NotEq,
    ast.Lt,
    ast.LtE,
    ast.Gt,
    ast.GtE,
    ast.In,
    ast.NotIn,
    ast.Is,
    ast.IsNot,
    ast.Name,
    ast.Load,
    ast.Constant,
    ast.List,
    ast.Tuple,
    ast.Set,
    ast.Subscript,
    ast.Call,
)
SAFE_BUILTINS = {"len": len, "bool": bool, "int": int, "min": min, "max": max}


def eval_invariant(expr: str, state_vars: dict[str, Any]) -> bool:
    """在严格 AST 白名单下求值不变式，防止任意代码执行。"""
    tree = ast.parse(expr, mode="eval")
    for node in ast.walk(tree):
        if not isinstance(node, ALLOWED_AST_NODES):
            raise ValueError(f"不支持的表达式节点：{type(node).__name__} in {expr!r}")
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in SAFE_BUILTINS:
                raise ValueError(f"不允许调用函数：{ast.dump(node.func)}")
    env = dict(SAFE_BUILTINS)
    env.update(state_vars)
    return bool(eval(compile(tree, "<invariant>", "eval"), {"__builtins__": {}}, env))


def validate_spec(spec: dict[str, Any]) -> None:
    for key in ("name", "initial", "states", "transitions"):
        if key not in spec:
            raise ValueError(f"规范缺少必填字段：{key}")
    if not isinstance(spec["states"], dict) or not spec["states"]:
        raise ValueError("states 必须为非空对象")
    if spec["initial"] not in spec["states"]:
        raise ValueError(f"initial 状态 {spec['initial']!r} 未定义于 states")
    for idx, t in enumerate(spec["transitions"]):
        for k in ("from", "action", "to"):
            if k not in t:
                raise ValueError(f"transitions[{idx}] 缺少字段：{k}")
        if t["from"] not in spec["states"] or t["to"] not in spec["states"]:
            raise ValueError(f"transitions[{idx}] 引用未定义状态：{t['from']} -> {t['to']}")


def analyze_spec(spec: dict[str, Any]) -> dict[str, Any]:
    """BFS 穷举可达状态空间，计算不变式最短违例路径、死锁与不可达状态。"""
    validate_spec(spec)
    states: dict[str, dict[str, Any]] = spec["states"]
    initial: str = spec["initial"]
    terminal: set[str] = set(spec.get("terminal", []))
    transitions: list[dict[str, str]] = spec["transitions"]
    invariants: list[dict[str, str]] = spec.get("invariants", [])

    adj: dict[str, list[tuple[str, str]]] = {s: [] for s in states}
    for t in transitions:
        adj[t["from"]].append((t["action"], t["to"]))

    # BFS：记录到达每个可达状态的最短路径 [(state, action), ..., (target, None)]
    paths: dict[str, list[tuple[str, str | None]]] = {initial: [(initial, None)]}
    q: deque[str] = deque([initial])
    while q:
        cur = q.popleft()
        for action, nxt in adj[cur]:
            if nxt not in paths:
                prev = paths[cur][:-1] + [(cur, action), (nxt, None)]
                paths[nxt] = prev
                q.append(nxt)

    unreachable = [s for s in states if s not in paths]
    deadlocks = [s for s in paths if s not in terminal and not adj[s]]

    violations: list[dict[str, Any]] = []
    for inv in invariants:
        inv_name = inv["name"]
        expr = inv["expr"]
        # 按 BFS 距离排序，首个命中即最短反例路径
        for s in sorted(paths.keys(), key=lambda x: (len(paths[x]), x)):
            ok = eval_invariant(expr, states[s])
            if not ok:
                violations.append(
                    {
                        "invariant": inv_name,
                        "expr": expr,
                        "state": s,
                        "path": [
                            {"state": st, "action": act}
                            for st, act in paths[s]
                        ],
                    }
                )
                break

    return {
        "name": spec["name"],
        "initial": initial,
        "terminal": sorted(terminal),
        "reachable": list(paths.keys()),
        "unreachable": unreachable,
        "deadlocks": deadlocks,
        "violations": violations,
        "ok": not violations and not deadlocks,
    }


def format_path(path: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for step in path:
        if step["action"] is not None:
            parts.append(f"{step['state']} --[{step['action']}]-->")
        else:
            parts.append(f"[{step['state']}]")
    return " ".join(parts)


def render_mermaid(spec: dict[str, Any], result: dict[str, Any]) -> str:
    violated_states = {v["state"] for v in result["violations"]}
    deadlock_states = set(result["deadlocks"])
    unreachable_states = set(result["unreachable"])
    lines = ["```mermaid", "stateDiagram-v2", f"    [*] --> {spec['initial']}"]
    for t in spec["transitions"]:
        lines.append(f"    {t['from']} --> {t['to']}: {t['action']}")
    for term in spec.get("terminal", []):
        lines.append(f"    {term} --> [*]")
    if violated_states:
        lines.append("    classDef violation fill:#fee,stroke:#c00,stroke-width:2px")
        for s in sorted(violated_states):
            lines.append(f"    class {s} violation")
    if deadlock_states:
        lines.append("    classDef deadlock fill:#fff3cd,stroke:#b58900,stroke-width:2px")
        for s in sorted(deadlock_states):
            lines.append(f"    class {s} deadlock")
    if unreachable_states:
        lines.append("    classDef unreachable stroke-dasharray: 5 5")
        for s in sorted(unreachable_states):
            lines.append(f"    class {s} unreachable")
    lines.append("```")
    return "\n".join(lines)


def render_ascii(spec: dict[str, Any], result: dict[str, Any]) -> str:
    violated = {v["state"] for v in result["violations"]}
    deadlocks = set(result["deadlocks"])
    unreachable = set(result["unreachable"])
    terminal = set(spec.get("terminal", []))

    def tag(state: str) -> str:
        marks: list[str] = []
        if state == spec["initial"]:
            marks.append("INIT")
        if state in terminal:
            marks.append("TERM")
        if state in violated:
            marks.append("VIOLATION")
        if state in deadlocks:
            marks.append("DEADLOCK")
        if state in unreachable:
            marks.append("UNREACHABLE")
        return f"[{state}{(':' + ','.join(marks)) if marks else ''}]"

    lines = [
        f"=== Statechart: {spec['name']} ===",
        f"Reachable: {len(result['reachable'])}/{len(spec['states'])} | "
        f"Violations: {len(result['violations'])} | Deadlocks: {len(result['deadlocks'])}",
        "",
        "Transitions:",
    ]
    for t in spec["transitions"]:
        lines.append(f"  {tag(t['from'])} --({t['action']})--> {tag(t['to'])}")
    if result["violations"]:
        lines.append("")
        lines.append("Shortest Violation Paths:")
        for v in result["violations"]:
            lines.append(
                f"  ! {v['invariant']} ({v['expr']}): {format_path(v['path'])}"
            )
    if result["deadlocks"]:
        lines.append("")
        lines.append(f"Deadlocks: {', '.join(result['deadlocks'])}")
    if result["unreachable"]:
        lines.append("")
        lines.append(f"Unreachable: {', '.join(result['unreachable'])}")
    return "\n".join(lines)


def self_test() -> int:
    # 1. 合法模型：全通过
    clean_spec = {
        "name": "lock-clean",
        "initial": "IDLE",
        "terminal": ["CLEAN"],
        "states": {
            "IDLE": {"locked": False, "holder": None},
            "LOCKED": {"locked": True, "holder": "pid1"},
            "CLEAN": {"locked": False, "holder": None},
        },
        "transitions": [
            {"from": "IDLE", "action": "acquire", "to": "LOCKED"},
            {"from": "LOCKED", "action": "release", "to": "CLEAN"},
        ],
        "invariants": [
            {"name": "locked_has_holder", "expr": "(not locked) or (holder is not None)"}
        ],
    }
    r1 = analyze_spec(clean_spec)
    assert r1["ok"] is True, f"合法模型应通过：{r1}"
    assert not r1["violations"] and not r1["deadlocks"] and not r1["unreachable"]
    m1 = render_mermaid(clean_spec, r1)
    a1 = render_ascii(clean_spec, r1)
    assert "stateDiagram-v2" in m1 and "IDLE --> LOCKED: acquire" in m1
    assert "=== Statechart: lock-clean ===" in a1 and "acquire" in a1

    # 2. 违例 + 死锁 + 不可达模型：须捕获最短路径
    buggy_spec = {
        "name": "lock-buggy",
        "initial": "IDLE",
        "terminal": ["CLEAN"],
        "states": {
            "IDLE": {"locked": False, "holder": None},
            "ZOMBIE": {"locked": True, "holder": None},
            "ORPHAN": {"locked": False, "holder": "ghost"},
            "CLEAN": {"locked": False, "holder": None},
        },
        "transitions": [
            {"from": "IDLE", "action": "crash_acquire", "to": "ZOMBIE"},
        ],
        "invariants": [
            {"name": "locked_has_holder", "expr": "(not locked) or (holder is not None)"}
        ],
    }
    r2 = analyze_spec(buggy_spec)
    assert r2["ok"] is False, "违例模型不得通过"
    assert len(r2["violations"]) == 1 and r2["violations"][0]["state"] == "ZOMBIE"
    assert format_path(r2["violations"][0]["path"]) == "IDLE --[crash_acquire]--> [ZOMBIE]"
    assert "ZOMBIE" in r2["deadlocks"]
    assert "ORPHAN" in r2["unreachable"] and "CLEAN" in r2["unreachable"]
    m2 = render_mermaid(buggy_spec, r2)
    a2 = render_ascii(buggy_spec, r2)
    assert "class ZOMBIE violation" in m2 and "Shortest Violation Paths:" in a2

    # 3. 注入安全检查：非法 AST（如 __import__）必须被拦截
    try:
        eval_invariant("__import__('os').system('echo bad')", {})
        raise AssertionError("非法表达式未被拦截")
    except ValueError:
        pass

    print("mana-statechart: self-test OK (clean + violation/deadlock/unreachable + ast-guard)")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="轻量有限状态机求解、不变式检查与双模（Mermaid + ASCII）状态图输出"
    )
    parser.add_argument("spec", nargs="?", help="JSON 规范文件路径（默认 .mana/veri/<target>.spec.json）")
    parser.add_argument("--format", choices=("both", "mermaid", "ascii", "json"), default="both")
    parser.add_argument("--self-test", action="store_true", help="运行内置正反例与安全自检")
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()
    if not args.spec:
        parser.error("必须提供 spec 路径或 --self-test")

    spec_path = Path(args.spec)
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    result = analyze_spec(spec)

    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif args.format == "mermaid":
        print(render_mermaid(spec, result))
    elif args.format == "ascii":
        print(render_ascii(spec, result))
    else:
        print(render_ascii(spec, result))
        print()
        print(render_mermaid(spec, result))

    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
