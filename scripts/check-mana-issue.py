#!/usr/bin/env python3
"""mana intake Issue 骨架校验器：6 段骨架缺项即非 0（多 lane 时另校验 Shared contracts 与 Ownership）。

用途：把 mana §1 intake 第 2 步的「Issue 定稿」变成机器可判定谓词——
进入 `/mana run` 之前先跑本脚本，`exit 0` 才可授权；非 0 回 intake 补齐。

校验 6 段：Depends on / Files / Build / Verify（须同时含 unit 与 live 子项）/
Review gate / Merge。当显式传入 `--multi-lane` 或正文中声明 ≥2 个 `lane-<id>` 时，
额外要求 `Shared contracts`（跨 lane 共享 API/数据契约）与 `Ownership`（lane -> 路径所有权矩阵，且禁止同一路径双写）。
markdown 标题层级不限（##/###/粗体行），大小写与空白差异不误判；缺哪段逐条点名，全部错误一次性列全。

示例：
  python3 scripts/check-mana-issue.py --self-test
  gh issue view 26 --json body -q .body | python3 scripts/check-mana-issue.py --body -
  python3 scripts/check-mana-issue.py --number 26
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys

# (段名, 缺项时的最小修法提示)
SECTIONS: list[tuple[str, str]] = [
    ("Depends on", "补一段列出父 Issue 与前置依赖（无前置也写明「无」）"),
    ("Files", "补一段列出本 lane 允许改动的文件边界"),
    ("Build", "补一段写明构建/实现要点"),
    ("Verify", "补一段验收命令，且必须同时含 unit 与 live 两类子项"),
    ("Review gate", "PR 描述须贴验收实际输出"),
    ("Merge", "补一段写明合并方式与合并后清理"),
]

MULTI_LANE_SECTIONS: list[tuple[str, str]] = [
    ("Shared contracts", "多 lane 并行时须补一段跨 lane 共享 API/数据契约（无跨 lane 接口也写明「无」）"),
    ("Ownership", "多 lane 并行时须补一段 lane -> 路径所有权矩阵（禁止同一路径双写）"),
]


def normalize(text: str) -> str:
    """小写并去掉所有非字母数字字符，吸收中英文标题/空白/标点差异。"""
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", text.lower())


def heading_title(line: str) -> str | None:
    """返回标题行文本；识别 `# 标题` 与整行 `**标题**` 粗体，其余返回 None。"""
    m = re.match(r"^\s*#{1,6}\s+(.+?)\s*$", line)
    if m:
        return m.group(1)
    m = re.match(r"^\s*\*\*(.+?)\*\*\s*[:：]?\s*$", line)
    if m:
        return m.group(1)
    return None


def parse_sections(body: str) -> dict[str, str]:
    """标题行 -> 该段正文（到下一个标题为止）；键为 normalize 后的标题。"""
    out: dict[str, str] = {}
    current: str | None = None
    for line in body.splitlines():
        title = heading_title(line)
        if title is not None:
            current = normalize(title)
            out[current] = ""
        elif current is not None:
            out[current] += line + "\n"
    return out


def find_section(sections: dict[str, str], name: str) -> str | None:
    """标题 normalize 后以前缀命中段名即可（兼容「Files（边界）」等注释后缀）。"""
    key = normalize(name)
    for title, content in sections.items():
        if title.startswith(key):
            return title + "\n" + content
    return None


def is_multi_lane_body(body: str) -> bool:
    """检测正文是否声明了 ≥2 个不同的 lane-<id> 标识。"""
    lanes = {m.group(0).lower() for m in re.finditer(r"\blane-[a-z0-9_]+\b", body, re.IGNORECASE)}
    return len(lanes) >= 2


def check_ownership_conflicts(ownership_text: str) -> list[str]:
    """解析 Ownership 段中 `lane-x: path1, path2` 行，检测跨 lane 双写同一路径。"""
    path_owners: dict[str, str] = {}
    conflicts: list[str] = []
    for raw_line in ownership_text.splitlines():
        m = re.search(r"\b(lane-[a-z0-9_]+)\b\s*[:：→>-]+\s*(.+)$", raw_line.strip(), re.IGNORECASE)
        if not m:
            continue
        lane_id = m.group(1).lower()
        for token in re.split(r"[,，\s]+", m.group(2)):
            cleaned = token.strip("`'\"()[]")
            if not cleaned or cleaned in ("-", "无", "readonly"):
                continue
            prev = path_owners.get(cleaned)
            if prev and prev != lane_id:
                conflicts.append(f"`Ownership` 段存在跨 lane 双写冲突：路径 `{cleaned}` 同时被 `{prev}` 与 `{lane_id}` 声明。")
            else:
                path_owners[cleaned] = lane_id
    return conflicts


def validate(body: str, multi_lane: bool | None = None) -> list[str]:
    """返回全部错误（缺项逐条点名），空列表即通过。"""
    sections = parse_sections(body)
    errors: list[str] = []
    verify_text: str | None = None
    for name, hint in SECTIONS:
        text = find_section(sections, name)
        if text is None:
            errors.append(f"缺 `{name}` 段：{hint}。")
        elif name == "Verify":
            verify_text = text
    if verify_text is not None:
        for sub, hint in (
            ("unit", "验收须含单元/自证命令（unit）子项"),
            ("live", "验收须含真实服务/端到端断言（live）子项"),
        ):
            if not re.search(rf"\b{sub}\b", verify_text, re.IGNORECASE):
                errors.append(f"`Verify` 段缺 `{sub}` 子项：{hint}。")

    need_multi = is_multi_lane_body(body) if multi_lane is None else multi_lane
    if need_multi:
        for name, hint in MULTI_LANE_SECTIONS:
            text = find_section(sections, name)
            if text is None:
                errors.append(f"缺 `{name}` 段：{hint}。")
            elif name == "Ownership":
                errors.extend(check_ownership_conflicts(text))
    return errors


def issue_body_from_gh(number: int) -> str:
    try:
        result = subprocess.run(
            ["gh", "issue", "view", str(number), "--json", "body", "-q", ".body"],
            capture_output=True, text=True, check=True,
        )
    except FileNotFoundError as err:
        raise SystemExit("check-mana-issue: gh 不可用（未安装或不在 PATH），无法经 --number 取正文") from err
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"check-mana-issue: gh issue view {number} 失败：{exc.stderr.strip()}") from exc
    return result.stdout


def self_test() -> int:
    full = "\n".join(
        [
            "# 标题",
            "## Depends on",
            "- #12",
            "## Files（边界）",
            "- a.py",
            "### Build",
            "要点",
            "**Verify（unit、live）**",
            "- unit：跑测试",
            "- live：真服务断言",
            "## Review gate",
            "贴输出",
            "## Merge",
            "squash",
        ]
    )
    assert validate(full) == [], validate(full)

    for name, _ in SECTIONS:
        lines = full.splitlines()
        start = next(i for i, ln in enumerate(lines) if ln.lstrip("#* ").lower().startswith(name.lower()[:5]))
        end = next((i for i in range(start + 1, len(lines)) if heading_title(lines[i])), len(lines))
        broken = "\n".join(lines[:start] + lines[end:])
        errs = validate(broken)
        key = name.lower().replace(" ", "")
        assert errs and any(key in e.lower().replace(" ", "") for e in errs), f"缺 {name} 段未被点名：{errs}"

    no_unit = full.replace("- unit：跑测试\n", "")
    no_live = full.replace("- live：真服务断言\n", "")
    assert any("unit" in e for e in validate(no_unit)), validate(no_unit)
    assert any("live" in e for e in validate(no_live)), validate(no_live)
    assert any("Verify" in e for e in validate("## Verify\n- 只有泛泛验收")), validate("## Verify\n- 只有泛泛验收")

    sections = parse_sections(full)
    assert find_section(sections, "Files") is not None  # 「Files（边界）」前缀命中

    # 多 lane 校验：含 lane-a / lane-b 时要求 Shared contracts 与 Ownership，且拦截跨 lane 路径双写
    multi_missing = full + "\n- lane-a 与 lane-b 并行\n"
    m_errs = validate(multi_missing)
    assert any("Shared contracts" in e for e in m_errs) and any("Ownership" in e for e in m_errs), m_errs

    multi_ok = (
        multi_missing
        + "## Shared contracts\n- 无跨 lane 共享可变状态\n"
        + "## Ownership\n- lane-a: scripts/a.py\n- lane-b: scripts/b.py\n"
    )
    assert validate(multi_ok) == [], validate(multi_ok)

    multi_conflict = (
        multi_missing
        + "## Shared contracts\n- 共享 state.json\n"
        + "## Ownership\n- lane-a: scripts/a.py\n- lane-b: scripts/a.py\n"
    )
    c_errs = validate(multi_conflict)
    assert any("双写冲突" in e for e in c_errs), c_errs

    print("✓ self-test ok")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="mana intake Issue 骨架校验器（缺项即非 0）")
    ap.add_argument("--body", help="Issue 正文文件路径，或 - 读 stdin")
    ap.add_argument("--number", type=int, help="经 gh issue view <N> 取正文")
    ap.add_argument("--multi-lane", action="store_true", help="强制要求多 lane 附加段（Shared contracts / Ownership）")
    ap.add_argument("--json", action="store_true", help="机器可读 JSON 输出")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        return self_test()
    if args.body and args.number:
        ap.error("--body 与 --number 二选一")
    if args.number:
        body = issue_body_from_gh(args.number)
    elif args.body == "-":
        body = sys.stdin.read()
    elif args.body:
        try:
            with open(args.body, encoding="utf-8") as fh:
                body = fh.read()
        except OSError as err:
            raise SystemExit(f"check-mana-issue: 无法读取 {args.body}：{err}") from err
    else:
        ap.error("需要 --body <file|-> 或 --number <N>")

    errors = validate(body, multi_lane=True if args.multi_lane else None)
    if args.json:
        print(json.dumps({"ok": not errors, "errors": errors}, ensure_ascii=False, indent=2))
    elif errors:
        print("❌ Issue 骨架缺项：")
        for e in errors:
            print(f"   - {e}")
    else:
        print("✓ Issue 骨架 6 段齐备（Depends on / Files / Build / Verify[unit,live] / Review gate / Merge）")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
