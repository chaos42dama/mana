#!/usr/bin/env bash
# mana 装机脚本（Issue #31）：把本仓库正本幂等安装到用户级目录。
#
# 仓库正本 = 唯一事实源；用户级目录（~/.omp/agent/skills、~/.omp/agent/extensions、
# ~/.pi/agent/extensions、~/.agents/skills）是安装产物，永远由本脚本覆盖，不要手改。
# 本脚本即「hand-synced list」这个设计缺陷的消除手段：手工 cp 列表会漂移
# （历史上 ~/.omp/agent/skills/mana/SKILL.md 曾落后正本 165 行）。
#
# 判定口径与 scripts/mana-preflight.sh 装机门一致：逐文件 `cmp -s`；不同（或目标缺失）
# 即漂移。按需 `chmod +x` 即本仓库正本；`extensions/pi/*.ts` 装成 `*.ts`。
#
# 用法:
#   bash scripts/mana-install.sh              # 安装/修复（幂等：内容相同不写，不动 mtime）
#   bash scripts/mana-install.sh --check      # 只比对不写；有漂移 exit 1
#   bash scripts/mana-install.sh --dry-run    # 打印将执行的动作，不写；有漂移 exit 1
#   bash scripts/mana-install.sh --help
#
# 只复制下表列出的文件（skills/mana/references/*.md 按 glob 展开，见 #59：新增
# references 文件自动纳入装机比对，不把文件名写死在表里）；绝不触碰
# settings.json / models.json / auth.json / ~/.omp/agent/config.yml 等配置与密钥。
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: bash scripts/mana-install.sh [--check|--dry-run|--help]
  (无参数)     安装：把仓库正本幂等同步到用户级目录（内容相同不写）
  --check      只比对不写；任一目标漂移则 exit 1
  --dry-run    打印将要执行的动作但不写；有漂移则 exit 1
  --help       显示本用法
仓库正本 = 唯一事实源；用户级目录是安装产物。
USAGE
}

mode=install
while (($#)); do
  case "$1" in
  --check) mode=check ;;
  --dry-run) mode=dry-run ;;
  --help | -h)
    usage
    exit 0
    ;;
  *)
    echo "mana-install: 未知参数: $1" >&2
    usage >&2
    exit 2
    ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${HOME:?HOME 未设置}"

# 源 → 目标映射表（相对 REPO_ROOT 的源；目标为绝对路径）
# 格式：<源相对路径>|<目标绝对路径>|<可选条件目录：该目录存在才安装/比对>
MAPPINGS=(
  "skills/mana/SKILL.md|$HOME_DIR/.omp/agent/skills/mana/SKILL.md|"
  "skills/mana/SKILL.md|$HOME_DIR/.agents/skills/mana/SKILL.md|$HOME_DIR/.agents/skills"
  "extensions/pi/mana-worker.ts|$HOME_DIR/.pi/agent/extensions/mana-worker.ts|"
  "extensions/pi/mana-worker-compact.ts|$HOME_DIR/.pi/agent/extensions/mana-worker-compact.ts|"
  "extensions/pi/precommit-review.ts|$HOME_DIR/.pi/agent/extensions/precommit-review.ts|"
  "extensions/pi/safe-guard.ts|$HOME_DIR/.pi/agent/extensions/safe-guard.ts|"
  "extensions/safe-guard.ts|$HOME_DIR/.omp/agent/extensions/safe-guard.ts|"
  "extensions/mana-compact.ts|$HOME_DIR/.omp/agent/extensions/mana-compact.ts|"
)

# references 目录走 glob 展开（#59）：仓库正本目录就是清单，
# 新增 references 文件自动逐文件比对，无需改本脚本。
for _ref in "$REPO_ROOT"/skills/mana/references/*.md; do
  [ -e "$_ref" ] || continue
  MAPPINGS+=("skills/mana/references/$(basename "$_ref")|$HOME_DIR/.omp/agent/skills/mana/references/$(basename "$_ref")|")
done

hash_of() { sha256sum "$1" 2>/dev/null | cut -c1-12; }

drift=0
printf '%-46s %-14s %-14s %s\n' '目标' '正本 hash' '目标 hash' '状态'
for entry in "${MAPPINGS[@]}"; do
  IFS='|' read -r src_rel dst cond <<<"$entry"
  src="$REPO_ROOT/$src_rel"
  [ -f "$src" ] || {
    echo "mana-install: 缺正本源文件: $src" >&2
    exit 2
  }
  if [ -n "$cond" ] && [ ! -d "$cond" ]; then
    printf '%-46s %-14s %-14s %s\n' "$dst" "$(hash_of "$src")" '-' 'skip（父目录不存在）'
    continue
  fi
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    printf '%-46s %-14s %-14s %s\n' "$dst" "$(hash_of "$src")" "$(hash_of "$dst")" 'ok'
    continue
  fi
  drift=1
  case "$mode" in
  check)
    printf '%-46s %-14s %-14s %s\n' "$dst" "$(hash_of "$src")" \
      "$([ -f "$dst" ] && hash_of "$dst" || echo '-')" \
      "$([ -f "$dst" ] && echo '漂移：目标落后正本' || echo '漂移：目标缺失')"
    ;;
  dry-run)
    printf '%-46s %-14s %-14s %s\n' "$dst" "$(hash_of "$src")" \
      "$([ -f "$dst" ] && hash_of "$dst" || echo '-')" \
      "将安装：cp $src_rel -> $dst"
    ;;
  install)
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    printf '%-46s %-14s %-14s %s\n' "$dst" "$(hash_of "$src")" "$(hash_of "$dst")" '已安装'
    ;;
  esac
done

echo "----"
case "$mode" in
check)
  if [ "$drift" -ne 0 ]; then
    echo "mana-install: 检测到装机漂移（见上表）；修复：bash scripts/mana-install.sh" >&2
    exit 1
  fi
  echo "mana-install: 无漂移，用户级目录与仓库正本一致"
  ;;
dry-run)
  if [ "$drift" -ne 0 ]; then
    echo "mana-install: [dry-run] 有漂移待安装（未写任何文件）" >&2
    exit 1
  fi
  echo "mana-install: [dry-run] 无漂移，无需安装"
  ;;
install)
  echo "mana-install: 安装完成（幂等；内容未变的文件未重写）"
  ;;
esac
