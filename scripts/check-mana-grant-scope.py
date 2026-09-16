#!/usr/bin/env python3
"""mana 授权范围守卫：判定变更集是否落在 CTO 一次性授权的 pattern 内。

用途：把 mana §0.6 的 "tier B 需 CTO 逐次批准" 换成可机器判定的谓词。
- `--paths` 模式：dispatch 前预测 lane 的 tier（只比对路径 glob，不看内容）。
- `--base/--rev` 模式：landing 前复核真实 diff：路径必须在授权 glob 内，
  且授权 toml 文件内改动的键必须落在允许的键前缀内（如 `ui.m.txt.`）。

通过 => 该 lane 视为 tier A，可自主 landing；否则停止并上报 CTO。

示例：
  python3 ops/scripts/check-mana-grant-scope.py --paths ops/config/products.m.dev.toml
  python3 ops/scripts/check-mana-grant-scope.py --base origin/main --rev HEAD \
      --allow-key ui.m.txt.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import subprocess
import sys
import tomllib

DEFAULT_ALLOW_PATHS: list[str] = []


def flatten(node: dict, prefix: str = "") -> dict:
    """toml dict -> {dotted.key: canonical-json-value}；list 视为叶子值。"""
    out: dict[str, str] = {}
    for key, value in node.items():
        path = f"{prefix}{key}"
        if isinstance(value, dict):
            out.update(flatten(value, f"{path}."))
        else:
            out[path] = json.dumps(value, sort_keys=True, ensure_ascii=False)
    return out


def changed_keys(base: dict, head: dict) -> list[str]:
    """返回新增/删除/改值的键，已排序。"""
    b, h = flatten(base), flatten(head)
    return sorted(k for k in set(b) | set(h) if b.get(k) != h.get(k))


def allowed_path(path: str, patterns: list[str]) -> bool:
    """pattern 以 `/` 结尾表示授权整棵子树；否则按 fnmatch 匹配。"""
    return any(path.startswith(p) if p.endswith("/") else fnmatch.fnmatch(path, p) for p in patterns)


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def load_toml(raw: str) -> dict:
    return tomllib.loads(raw) if raw.strip() else {}


def check_paths(paths: list[str], patterns: list[str]) -> int:
    bad = [p for p in paths if not allowed_path(p, patterns)]
    if bad:
        print("❌ 变更集越出授权范围：")
        for p in bad:
            print(f"   - {p}")
        return 1
    print(f"✓ 路径全部落在授权 pattern 内（{len(paths)} 个文件）")
    return 0


def check_diff(base: str, rev: str, patterns: list[str], key_prefixes: list[str]) -> int:
    paths = [p for p in git("diff", "--name-only", f"{base}...{rev}").splitlines() if p]
    if not paths:
        print("✓ 无变更")
        return 0
    if check_paths(paths, patterns):
        return 1
    status = 0
    for path in paths:
        if not path.endswith(".toml"):
            continue
        try:
            before = load_toml(git("show", f"{base}:{path}"))
        except subprocess.CalledProcessError:
            before = {}
        with open(path, "rb") as fh:
            after = tomllib.load(fh)
        offending = [k for k in changed_keys(before, after) if not any(k.startswith(p) for p in key_prefixes)]
        if offending:
            status = 1
            print(f"❌ {path} 改动越出允许键前缀 {key_prefixes}：")
            for k in offending:
                print(f"   - {k}")
        else:
            print(f"✓ {path} 改动键全部落在 {key_prefixes}")
    return status


def self_test() -> int:
    base = {"ui": {"m": {"txt": {"a": "1"}}, "access": {"task_actions": True}}}
    same = {"ui": {"m": {"txt": {"a": "1"}}, "access": {"task_actions": True}}}
    copy_only = {"ui": {"m": {"txt": {"a": "2", "b": "3"}}, "access": {"task_actions": True}}}
    flag_flip = {"ui": {"m": {"txt": {"a": "1"}}, "access": {"task_actions": False}}}

    assert changed_keys(base, same) == []
    assert changed_keys(base, copy_only) == ["ui.m.txt.a", "ui.m.txt.b"]
    assert changed_keys(base, flag_flip) == ["ui.access.task_actions"]
    assert not allowed_path("apps/config/copy.dev.toml", DEFAULT_ALLOW_PATHS)
    assert not allowed_path("apps/webx/x.tsx", ["apps/web/"])
    assert allowed_path("apps/web/components/x.tsx", ["apps/web/"])
    assert not allowed_path("apps/webx/components/x.tsx", ["apps/web/"])

    # 端到端：文案键改动通过，开关翻转被拦
    prefixes = ["ui.m.txt."]
    for node, expected in ((copy_only, 0), (flag_flip, 1)):
        offending = [k for k in changed_keys(base, node) if not any(k.startswith(p) for p in prefixes)]
        assert (1 if offending else 0) == expected, offending
    print("✓ self-test ok")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", help="基线 ref，如 origin/main")
    ap.add_argument("--rev", default="HEAD", help="被检查的 ref，默认 HEAD")
    ap.add_argument("--paths", help="逗号分隔的声明路径（dispatch 前预测，不读内容）")
    ap.add_argument("--allow-path", action="append", default=[], help="授权路径 glob，可重复")
    ap.add_argument("--allow-key", action="append", default=[], help="授权 toml 键前缀，可重复")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        return self_test()
    patterns = args.allow_path or DEFAULT_ALLOW_PATHS
    if not patterns:
        ap.error("无 --allow-path：默认无授权，必须显式给出")
    if args.paths:
        return check_paths([p.strip() for p in args.paths.split(",") if p.strip()], patterns)
    if not args.base:
        ap.error("需要 --base 或 --paths")
    if not args.allow_key:
        ap.error("--base 模式必须给出 --allow-key")
    return check_diff(args.base, args.rev, patterns, args.allow_key)


if __name__ == "__main__":
    sys.exit(main())
