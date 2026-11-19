#!/usr/bin/env python3
"""run 收尾审计：锁是否真释放、还有谁握着 orchestrator.lock 的 inode。

为什么不能只 `pgrep -af 'mana-run-lock|<run-id>'`（run #3 实测）：
`mana-run-lock.py` 用 `os.execvpe` 落地成目标命令，进程 cmdline 里**不再含脚本名**；
一个握锁的孤儿 bash 对该 pgrep 是假阴性。唯一可靠的取证是按锁文件 (st_dev, st_ino)
扫 `/proc/<pid>/fd`——exec 前后是同一进程、同一 inode，改名/删路径都不影响。

只读：不取锁、不写 state、不删任何东西。探测用 `LOCK_EX|LOCK_NB` 后立刻 `LOCK_UN`，
未持有锁时不改变任何人的状态。
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import stat
import sys
from pathlib import Path

LOCK_NAME = "orchestrator.lock"


def fail(message: str, code: int = 3) -> int:
    print(f"mana-run-audit: {message}", file=sys.stderr)
    return code


def probe_flock(lock: Path) -> bool | None:
    """True=可独占（锁空闲）, False=被别人持有, None=探测失败。"""
    try:
        with lock.open("a+", encoding="utf-8") as fh:
            try:
                fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return False
            fcntl.flock(fh, fcntl.LOCK_UN)
            return True
    except OSError:
        return None


def read_link(path: str) -> str | None:
    try:
        return os.readlink(path)
    except OSError:
        return None


def is_fifo(path: str) -> bool:
    """命名 fifo 判定。

    两种输入都要支持：① 直接给 fifo 路径（run 目录扫描，readlink 必然 EINVAL）；
    ② 给 `/proc/<pid>/fd/N`（匿名管道 readlink 是 `pipe:[..]`，命名 fifo 才是路径）。
    """
    target = read_link(path)
    if target is not None and target.startswith(("pipe:", "socket:", "anon_inode:")):
        return False
    try:
        return stat.S_ISFIFO(os.stat(path).st_mode)
    except OSError:
        return False


def process_info(pid: int, fd: str, lock: Path) -> dict:
    proc = f"/proc/{pid}"
    try:
        cmdline = Path(f"{proc}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace").strip()
    except OSError:
        cmdline = ""
    try:
        fields = Path(f"{proc}/stat").read_text(errors="replace").rsplit(")", 1)[1].split()
        state = fields[0] if fields else "?"
    except (OSError, IndexError):
        state = "?"
    try:
        wchan = Path(f"{proc}/wchan").read_text(errors="replace").strip() or "-"
    except OSError:
        wchan = "-"
    stdin_link = read_link(f"{proc}/fd/0")
    stdin_fifo = stdin_link is not None and is_fifo(f"{proc}/fd/0")
    return {
        "pid": pid,
        "state": state,
        "wchan": wchan,
        "cmdline": cmdline,
        "lock_fd": fd,
        "stdin": stdin_link,
        "stdin_fifo": stdin_fifo,
        "lock_path": str(lock),
    }


def find_holders(dev: int, ino: int, lock: Path) -> list[dict]:
    """扫 /proc/*/fd 找持有该 inode 的进程（含 exec 后的 shell 与 fork 后代会）。"""
    found: list[dict] = []
    me = os.getpid()
    try:
        entries = os.listdir("/proc")
    except OSError as exc:
        print(f"WARN：无法读取 /proc（{exc}）；holder 取证缺失，仅 flock 探测有效", file=sys.stderr)
        return found
    for entry in entries:
        if not entry.isdigit():
            continue
        pid = int(entry)
        if pid == me:
            continue
        fd_dir = f"/proc/{pid}/fd"
        try:
            fds = os.listdir(fd_dir)
        except OSError:
            continue
        for fd in fds:
            try:
                st = os.stat(f"{fd_dir}/{fd}")
            except OSError:
                continue
            if (st.st_dev, st.st_ino) == (dev, ino):
                found.append(process_info(pid, fd, lock))
                break
    return sorted(found, key=lambda h: h["pid"])


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="mana-run-audit",
        description="run 收尾审计：锁是否释放、谁还握着锁 inode（只读）",
    )
    parser.add_argument("run_dir", help="run 目录，如 <repo>/.mana/<run-id>")
    parser.add_argument(
        "--expect",
        choices=("free", "held"),
        default="free",
        help="期望态：free=收尾后（默认），held=run 进行中诊断",
    )
    parser.add_argument("--json", action="store_true", help="以 JSON 输出")
    args = parser.parse_args()

    try:
        run_dir = Path(args.run_dir).resolve(strict=True)
    except OSError as exc:
        return fail(f"RUN_DIR 不可解析：{exc}")
    if not run_dir.is_dir():
        return fail(f"RUN_DIR 不是目录：{run_dir}")

    lock = run_dir / LOCK_NAME
    if not lock.exists():
        return fail(f"缺锁文件：{lock}（未初始化或目录给错）")

    st = lock.stat()
    free = probe_flock(lock)
    holders = find_holders(st.st_dev, st.st_ino, lock)
    fifos = sorted(p.name for p in run_dir.iterdir() if is_fifo(str(p)))

    detached = [h for h in holders if h["stdin_fifo"]]
    # 判据只看锁状态与 holder 本身：
    # - expect=free：锁空闲且无 holder 才算干净；
    # - expect=held：锁被持有且 holder 的 stdin 不是命名 fifo（那正是死锁签名）；
    # `fifo_files` 仅作线索输出，不参与判定——run #3 的 fifo 在 run 目录之外
    # （`/tmp/mana-nrc-3.fifo`），按目录扫 fifo 抓不到，抓 holder 的 stdin 才是不变量。
    if args.expect == "free":
        clean = free is True and not holders
    else:
        clean = free is False and bool(holders) and not detached

    report = {
        "run_dir": str(run_dir),
        "lock": str(lock),
        "inode": st.st_ino,
        "dev": st.st_dev,
        "flock_free": free,
        "holders": holders,
        "detached_stdin_holders": [h["pid"] for h in detached],
        "fifo_files": fifos,
        "expect": args.expect,
        "clean": clean,
    }

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"run-dir: {run_dir}")
        print(f"lock:    {lock}  (dev={st.st_dev} ino={st.st_ino})")
        print(f"flock:   {'FREE' if free else 'HELD' if free is False else 'UNKNOWN'}")
        if holders:
            for h in holders:
                print(f"holder:  pid={h['pid']} state={h['state']} wchan={h['wchan']} fd={h['lock_fd']}")
                print(f"         cmd: {h['cmdline'] or '<不可读>'}")
                if h["stdin_fifo"]:
                    print(f"         stdin: {h['stdin']}  ← stdin 是命名 fifo：写端不关则永不 EOF，锁不会自行释放")
        else:
            print("holder:  none")
        if fifos:
            print(f"fifo:    {', '.join(fifos)}  ← run 目录不应有 fifo（禁止 fifo 喂命令建持锁会话）")
        print(f"verdict: {'CLEAN' if clean else 'DIRTY'} (expect={args.expect})")

    return 0 if clean else 1


if __name__ == "__main__":
    sys.exit(main())
