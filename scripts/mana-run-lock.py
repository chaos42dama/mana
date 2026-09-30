"""Execute one run session with an inherited, cooperative POSIX flock."""

import argparse
import fcntl
import json
import os
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(
        prog="mana-run-lock",
        usage="%(prog)s RUN_DIR OWNER -- COMMAND [ARGS ...]",
    )
    parser.add_argument("run_dir")
    parser.add_argument("owner")
    argv = sys.argv[1:]
    if len(argv) < 4 or argv[2] != "--" or not argv[3]:
        parser.error("expected RUN_DIR OWNER -- COMMAND [ARGS ...]")
    args = parser.parse_args(argv[:2])
    if not args.owner.strip() or not args.owner.isprintable():
        parser.error("OWNER must be a nonblank printable session identifier")

    try:
        run_dir = Path(args.run_dir).resolve(strict=True)
        if not run_dir.is_dir():
            parser.error(f"RUN_DIR is not a directory: {run_dir}")
        # Never truncate before locking, or unlink this stable lock inode.
        with (run_dir / "orchestrator.lock").open("a+", encoding="utf-8") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print(f"mana-run-lock: locked: {run_dir}", file=sys.stderr)
                return 73
            lock.seek(0)
            lock.truncate()
            json.dump({"owner": args.owner, "pid": os.getpid(), "run_dir": str(run_dir)}, lock)
            lock.write("\n")
            lock.flush()
            os.set_inheritable(lock.fileno(), True)
            try:
                os.execvpe(argv[3], argv[3:], os.environ)
            except OSError as exc:
                print(f"mana-run-lock: cannot exec {argv[3]!r}: {exc}", file=sys.stderr)
                return 127 if isinstance(exc, FileNotFoundError) else 126
    except (OSError, RuntimeError) as exc:
        print(f"mana-run-lock: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
