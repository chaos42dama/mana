#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: mana-heartbeat.sh [--once] [--repo PATH]... [--interval SEC] [--timeout MS] [--log PATH]
  --once              Run one sweep and exit
  --repo PATH         Repository to sweep (repeatable)
  --interval SEC      Loop interval in seconds (default: 180)
  --timeout MS        herdr wait timeout in milliseconds (default: 60000)
  --log PATH          Append log lines to PATH (default: stderr)
  --help              Show this usage
USAGE
}

once=0
interval=180
timeout_ms=60000
log_path=
repos=()

while (($#)); do
  case "$1" in
  --once)
    once=1
    shift
    ;;
  --repo)
    (($# >= 2)) || {
      echo "missing value for --repo" >&2
      exit 2
    }
    repos+=("$2")
    shift 2
    ;;
  --interval)
    (($# >= 2)) || {
      echo "missing value for --interval" >&2
      exit 2
    }
    [[ "$2" =~ ^[0-9]+$ ]] || {
      echo "invalid --interval" >&2
      exit 2
    }
    interval=$2
    shift 2
    ;;
  --timeout)
    (($# >= 2)) || {
      echo "missing value for --timeout" >&2
      exit 2
    }
    [[ "$2" =~ ^[0-9]+$ ]] || {
      echo "invalid --timeout" >&2
      exit 2
    }
    timeout_ms=$2
    shift 2
    ;;
  --log)
    (($# >= 2)) || {
      echo "missing value for --log" >&2
      exit 2
    }
    log_path=$2
    shift 2
    ;;
  --help)
    usage
    exit 0
    ;;
  *)
    echo "unknown option: $1" >&2
    usage >&2
    exit 2
    ;;
  esac
done

log_line() {
  local repo=$1 run_id=$2 agent=$3 status=$4 action=$5
  local line
  line="$(date -u '+%Y-%m-%dT%H:%M:%SZ') repo=$repo run=$run_id agent=$agent status=$status action=$action"
  if [[ -n "$log_path" ]]; then
    printf '%s\n' "$line" >>"$log_path"
  else
    printf '%s\n' "$line" >&2
  fi
}

repo_hash() {
  printf '%s' "$1" | sha256sum | cut -c1-16
}

sweep_repo() {
  local repo=$1 lock_file state_file run_dir run_id agent observed lanes_ok
  [[ -d "$repo/.mana" ]] || return 0
  lock_file="/tmp/mana-heartbeat-$(repo_hash "$repo").lock"
  exec {lock_fd}>"$lock_file"
  if ! flock -n "$lock_fd"; then
    log_line "$repo" "-" "-" "unknown" "lock-busy"
    exec {lock_fd}>&-
    return 0
  fi

  while IFS= read -r -d '' state_file; do
    run_dir=${state_file%/state.json}
    run_id=${run_dir##*/}
    if ! jq -e '.lanes | type == "array" and length > 0' "$state_file" >/dev/null 2>&1; then
      log_line "$repo" "$run_id" "-" "invalid" "skip"
      continue
    fi
    agent=$(jq -r '.orchestrator.agent_name // empty' "$state_file" 2>/dev/null || true)
    if [[ -z "$agent" ]]; then
      log_line "$repo" "$run_id" "-" "missing-agent" "skip"
      continue
    fi
    lanes_ok=$(jq -r 'any(.lanes[]; (.status // "") as $s | $s == "planned" or $s == "running" or $s == "verifying")' "$state_file" 2>/dev/null || printf 'false')
    if [[ "$lanes_ok" != true ]]; then
      log_line "$repo" "$run_id" "$agent" "terminal" "skip"
      continue
    fi

    observed=$(herdr agent get "$agent" 2>&1 || true)
    if grep -qi 'not_found' <<<"$observed"; then
      log_line "$repo" "$run_id" "$agent" "not_found" "skip"
      continue
    fi
    status=$(grep -Eio '\b(idle|done|working)\b' <<<"$observed" | head -1 | tr '[:upper:]' '[:lower:]' || true)
    case "$status" in
    idle | done)
      herdr agent prompt "$agent" "/mana resume $run_id" --wait --timeout "$timeout_ms" >/dev/null 2>&1 || true
      log_line "$repo" "$run_id" "$agent" "$status" "resume-prompt"
      ;;
    working)
      log_line "$repo" "$run_id" "$agent" "$status" "skip"
      ;;
    *)
      log_line "$repo" "$run_id" "$agent" "unknown" "skip"
      ;;
    esac
  done < <(find "$repo/.mana" -mindepth 2 -maxdepth 2 -type f -name state.json -print0 2>/dev/null)

  flock -u "$lock_fd"
  exec {lock_fd}>&-
}

[[ ${#repos[@]} -gt 0 ]] || repos=("$(pwd)")
while :; do
  for repo in "${repos[@]}"; do sweep_repo "$repo"; done
  ((once)) && exit 0
  sleep "$interval"
done
