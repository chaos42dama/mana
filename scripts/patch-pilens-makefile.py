#!/usr/bin/env python3
"""pi-lens 对 Makefile 误报 shellcheck 的修复器 (幂等)。

问题: pi-lens 把 Makefile 归为 kind="shell" (file-kinds.js 的 SPECIAL_FILENAMES),
      dispatcher 遂派 shellcheck runner 对它跑。但 Makefile 不是 shell 脚本,
      shellcheck 报 SC2148(非 shell) 与内嵌片段的一堆 SC2034/SC2068/SC2145 ——
      实测 src/tests/Makefile 得 "2 blocking, 12 warning"。worker 曾为此反复
      "修"一个不存在的错误, 空转 70+ 分钟。

修法 (两处, 缺一不可):
  A. shellcheck runner 自身按扩展名早退 —— 治本, 不依赖上游 kind 归类。
     这是唯一真正生效的一处: 实测只改 kind 分类时 Makefile 仍被扫
     (analyze-cli 冷启动路径不按 kind 派发)。
  B. file-kinds 把 Makefile 归为 kind="make" 并纳入 CODE_KINDS —— 语义正确,
     避免其他按 kind 分派的地方误判为 shell。

幂等: 已修则跳过。升级 pi-lens 覆盖后重跑即恢复。
用法: python3 patch-pilens-makefile.py [--check]
"""
import re
import sys
import pathlib

ROOT = pathlib.Path.home() / ".pi/agent/npm/node_modules/pi-lens"

RUNNER = ROOT / "dist/clients/dispatch/runners/shellcheck.js"
KIND_FILES = [ROOT / "dist/clients/file-kinds.js", ROOT / "dist/index.js"]

GUARD = "只对真 shell 脚本跑"


def patch_runner(path: pathlib.Path, check: bool) -> str:
    if not path.is_file():
        return f"MISS {path}"
    s = path.read_text()
    if GUARD in s:
        return f"SKIP {path.name} (已修)"
    anchor = "    async run(ctx) {\n        const cwd = ctx.cwd || process.cwd();"
    if s.count(anchor) != 1:
        return f"FAIL {path.name}: run 锚点命中 {s.count(anchor)} 次"
    inject = (
        "    async run(ctx) {\n"
        f"        // {GUARD}。Makefile/CMakeLists/Dockerfile 不是 shell 脚本 ——\n"
        "        // shellcheck 对它们会报 SC2148(非 shell) 与内嵌片段的一堆误报\n"
        "        // (SC2034/SC2068/SC2145), 这些既非真实缺陷也无法\"修\", 只会误导。\n"
        "        // 按扩展名判定, 不依赖上游 file-kinds 的 kind 归类。\n"
        "        if (!/\\.(sh|bash|zsh|ksh)$/i.test(ctx.filePath || \"\")) {\n"
        "            return { status: \"skipped\", diagnostics: [], semantic: \"none\" };\n"
        "        }\n"
        "        const cwd = ctx.cwd || process.cwd();"
    )
    s = s.replace(anchor, inject)
    if check:
        return f"WOULD-PATCH {path.name}"
    path.write_text(s)
    return f"PATCHED {path.name}"


def patch_kind(path: pathlib.Path, check: bool) -> str:
    if not path.is_file():
        return f"MISS {path}"
    s = path.read_text()
    if 'kind: "make"' in s:
        return f"SKIP {path.name} (已修)"
    a = '{ pattern: /^Makefile$/i, kind: "shell" },'
    if s.count(a) != 1:
        return f"FAIL {path.name}: Makefile 归类锚点命中 {s.count(a)} 次"
    s = s.replace(a, '{ pattern: /^Makefile$/i, kind: "make" },')
    m = re.search(r'("clojure",\n(\s+)"cmake",\n)', s)
    if not m:
        return f"FAIL {path.name}: CODE_KINDS 锚点未命中"
    s = s[: m.end()] + f'{m.group(2)}"make",\n' + s[m.end():]
    m2 = re.search(r'(\n(\s+)ocaml: \["\.ml", "\.mli"\],)', s)
    if not m2:
        return f"FAIL {path.name}: KIND_EXTENSIONS 锚点未命中"
    s = s[: m2.start()] + f'\n{m2.group(2)}make: [],' + s[m2.start():]
    if check:
        return f"WOULD-PATCH {path.name}"
    path.write_text(s)
    return f"PATCHED {path.name}"


def main() -> int:
    check = "--check" in sys.argv
    rc = 0
    for fn, target in [(patch_runner, RUNNER)] + [(patch_kind, f) for f in KIND_FILES]:
        r = fn(target, check)
        print(r)
        if r.startswith(("FAIL", "MISS")):
            rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
