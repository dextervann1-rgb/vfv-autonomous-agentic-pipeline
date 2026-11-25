#!/usr/bin/env bash
# ==============================================================================
# FILE: collect-core6-readiness.sh
# STATUS: VERSION 2.0 (live-safe readiness and gate collector)
# TARGET: Core 6 repositories under dextervann1-rgb
#
# Exit status:
#   0  report collected; use --strict to fail when any repository is not ready
#   1  command/authentication/API error, or a readiness failure with --strict
# ===============================================================================
set -Eeuo pipefail

OWNER="${OWNER:-dextervann1-rgb}"
STRICT=false
JSON=false

CORE_REPOS=(
  "vfv-autonomous-agentic-pipeline"
  "vanndiamond-flash-foundry"
  "og8oh-muse-hybrid-superagent-v3"
  "omega-grand-scheme"
  "8-Leaps-of-Faith_space"
  "maze-miner-race-game"
)

usage() {
  cat <<'EOF'
Usage: collect-core6-readiness.sh [--strict] [--json]

  --strict  exit 1 if any repository is missing a required gate or has an error
  --json    emit one JSON object per repository instead of a human-readable table
  OWNER     override the GitHub owner through the environment, if needed
EOF
}

for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=true ;;
    --json) JSON=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Error: unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

for command in gh jq; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Error: $command is required." >&2
    exit 2
  fi
done

if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  echo "Error: authenticate GitHub CLI first (gh auth login)." >&2
  exit 2
fi

# Run a gh API request while preserving the error text for classification.
# Usage: api_capture variable endpoint [extra gh api arguments...]
api_capture() {
  local __result_var="$1"
  local endpoint="$2"
  shift 2
  local error_file output status
  error_file="$(mktemp)"
  if output="$(gh api "$endpoint" "$@" 2>"$error_file")"; then
    # Some GH CLI configurations emit ANSI colors even when stdout is captured.
    # Remove them before handing the response to jq.
    output="$(printf '%s' "$output" | sed $'s/\033\\[[0-9;]*m//g')"
    rm -f "$error_file"
    printf -v "$__result_var" '%s' "$output"
    return 0
  fi
  status=$?
  API_ERROR="$(tr '\n' ' ' < "$error_file")"
  rm -f "$error_file"
  printf -v "$__result_var" '%s' ''
  return "$status"
}

classify_api_error() {
  if [[ "${API_ERROR:-}" =~ (HTTP[[:space:]]+404|404[[:space:]]|Not[[:space:]]Found) ]]; then
    printf 'NOT_FOUND'
  elif [[ "${API_ERROR:-}" =~ (HTTP[[:space:]]+401|HTTP[[:space:]]+403|Bad[[:space:]]+credentials|Forbidden|Resource[[:space:]]+not[[:space:]]+accessible) ]]; then
    printf 'FORBIDDEN'
  else
    printf 'ERROR'
  fi
}

short_run_status() {
  local runs_json="$1"
  jq -r '
    .workflow_runs[0] as $r |
    if $r == null then "NONE"
    else
      (($r.name // "workflow") + "#" + (($r.run_number // 0) | tostring)
       + " " + ($r.status // "unknown") + "/" + ($r.conclusion // "in_progress"))
    end
  ' <<<"$runs_json"
}

if [[ "$JSON" != true ]]; then
  printf '%-33s | %-13s | %-42s | %-11s | %-18s\n' \
    "REPOSITORY" "DEFAULT_PROTECTION" "LATEST_DEFAULT_RUN" "SEPOLIA_ENV" "MAINNET_GATE"
  printf '%s\n' "----------------------------------+---------------+--------------------------------------------+-------------+-------------------"
fi

had_error=false
not_ready=false

for repo in "${CORE_REPOS[@]}"; do
  full_repo="${OWNER}/${repo}"
  main_protection="ERROR"
  latest_run="ERROR"
  sepolia_env="ERROR"
  mainnet_gate="ERROR"
  env_json=''
  default_branch=""

  if api_capture repo_json "/repos/${full_repo}"; then
    if ! default_branch="$(jq -r '.default_branch // empty' <<<"$repo_json")" || [[ -z "$default_branch" ]]; then
      main_protection="ERROR"; latest_run="ERROR"; had_error=true
    fi
  else
    case "$(classify_api_error)" in
      NOT_FOUND) main_protection="MISSING_REPOSITORY"; not_ready=true ;;
      FORBIDDEN) main_protection="FORBIDDEN"; had_error=true ;;
      *) main_protection="ERROR"; had_error=true ;;
    esac
  fi

  # Check that the default branch exists before checking protection. GitHub returns 404 for
  # both a missing branch and an unprotected existing branch.
  if [[ -z "$default_branch" ]]; then
    : # Preserve the repository lookup status above.
  elif api_capture branch_json "/repos/${full_repo}/branches/${default_branch}"; then
    if api_capture protection_json "/repos/${full_repo}/branches/${default_branch}/protection"; then
      main_protection="ACTIVE"
    else
      case "$(classify_api_error)" in
        NOT_FOUND) main_protection="UNPROTECTED" ;;
        FORBIDDEN) main_protection="FORBIDDEN"; had_error=true ;;
        *) main_protection="ERROR"; had_error=true ;;
      esac
    fi
  else
    case "$(classify_api_error)" in
      NOT_FOUND) main_protection="NO_DEFAULT_BRANCH"; not_ready=true ;;
      FORBIDDEN) main_protection="FORBIDDEN"; had_error=true ;;
      *) main_protection="ERROR"; had_error=true ;;
    esac
  fi

  # Query the latest run on the default branch, rather than an arbitrary run
  # from another branch or event.
  if [[ -n "$default_branch" && "$main_protection" != "NO_DEFAULT_BRANCH" && "$main_protection" != "MISSING_REPOSITORY" ]]; then
    if api_capture runs_json "/repos/${full_repo}/actions/runs?branch=${default_branch}&per_page=1"; then
      latest_run="$(short_run_status "$runs_json")"
    else
      case "$(classify_api_error)" in
        FORBIDDEN) latest_run="FORBIDDEN"; had_error=true ;;
        *) latest_run="ERROR"; had_error=true ;;
      esac
    fi
  else
    if [[ "$main_protection" == "MISSING_REPOSITORY" ]]; then
      latest_run="MISSING_REPOSITORY"
    else
      latest_run="NO_DEFAULT_BRANCH"
    fi
  fi

  if api_capture env_json "/repos/${full_repo}/environments?per_page=100"; then
    if ! sepolia_env="$(jq -r '
      if any(.environments[]?; .name == "base-sepolia") then "CONFIGURED" else "MISSING" end
    ' <<<"$env_json")"; then
      sepolia_env="ERROR"; had_error=true
    fi

    if ! mainnet_gate="$(jq -r '
      [.environments[]?
       | select(.name == "base-mainnet" or .name == "production")] as $targets |
      if ($targets | length) == 0 then "MISSING"
      elif any($targets[]; any((.protection_rules // [])[]?; .type == "required_reviewers")) then "REVIEW_GATED"
      elif any($targets[]; ((.deployment_branch_policy // {}) | (.protected_branches == true or .custom_branch_policies == true))) then "BRANCH_GATED"
      elif any($targets[]; any((.protection_rules // [])[]?; .type == "wait_timer")) then "TIMER_ONLY"
      else "UNGATED"
      end
    ' <<<"$env_json")"; then
      mainnet_gate="ERROR"; had_error=true
    fi
  else
    case "$(classify_api_error)" in
      FORBIDDEN) sepolia_env="FORBIDDEN"; mainnet_gate="FORBIDDEN" ;;
      *) sepolia_env="ERROR"; mainnet_gate="ERROR" ;;
    esac
    had_error=true
  fi

  [[ "$main_protection" == "ACTIVE" ]] || not_ready=true
  [[ "$sepolia_env" == "CONFIGURED" ]] || not_ready=true
  [[ "$mainnet_gate" == "REVIEW_GATED" || "$mainnet_gate" == "BRANCH_GATED" ]] || not_ready=true

  if [[ "$JSON" == true ]]; then
    jq -cn \
      --arg repository "$full_repo" \
      --arg default_branch "$default_branch" \
      --arg main_protection "$main_protection" \
      --arg latest_run "$latest_run" \
      --arg sepolia_env "$sepolia_env" \
      --arg mainnet_gate "$mainnet_gate" \
      '{repository:$repository, default_branch:$default_branch, default_branch_protection:$main_protection, latest_default_run:$latest_run, sepolia_environment:$sepolia_env, mainnet_gate:$mainnet_gate}'
  else
    printf '%-33s | %-13s | %-42s | %-11s | %-18s\n' \
      "$repo" "$main_protection" "$latest_run" "$sepolia_env" "$mainnet_gate"
  fi
done

if [[ "$JSON" != true ]]; then
  printf '\nLegend: ACTIVE=branch protection enabled; REVIEW_GATED/BRANCH_GATED=mainnet has a release gate.\n'
  printf 'Use --strict to make missing gates fail CI. API permission failures always fail.\n'
fi

if [[ "$had_error" == true ]]; then
  exit 1
fi
if [[ "$STRICT" == true && "$not_ready" == true ]]; then
  exit 1
fi
exit 0
