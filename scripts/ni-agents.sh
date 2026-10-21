#!/usr/bin/env bash
# Stop, start or inspect Native Instruments' hardware agents so mk3d can own the Maschine MK3.
# Never deletes or edits any NI file; it only uses launchctl, kill and `open`.
set -euo pipefail

UID_NUM="$(id -u)"
GUI_DOMAIN="gui/${UID_NUM}"
AGENT_DIR="/Library/Application Support/Native Instruments/Hardware"
AGENT_NAMES=(NIHardwareAgent NIHostIntegrationAgent)
# NI apps that relaunch the agents while they are running.
NI_APPS=("Maschine 3" "Maschine 2" "Controller Editor" "Komplete Kontrol")
PLIST_DIRS=("/Library/LaunchAgents" "${HOME}/Library/LaunchAgents")
NI_PATTERN='native-instruments|NIHardware|NIHostIntegration'

ni_plists() {
  local dir file
  for dir in "${PLIST_DIRS[@]}"; do
    [[ -d "$dir" ]] || continue
    for file in "$dir"/*.plist; do
      [[ -e "$file" ]] || continue
      if [[ "$(basename "$file")" =~ $NI_PATTERN ]] || grep -qE "$NI_PATTERN" "$file" 2>/dev/null; then
        echo "$file"
      fi
    done
  done
}

agent_pids() {
  local name
  for name in "${AGENT_NAMES[@]}"; do
    pgrep -x "$name" || true
  done
}

running_ni_apps() {
  local app
  for app in "${NI_APPS[@]}"; do
    pgrep -x "$app" >/dev/null && echo "$app"
  done
  return 0
}

status() {
  echo "LaunchAgent plists matching NI:"
  local plists
  plists="$(ni_plists)"
  if [[ -n "$plists" ]]; then sed 's/^/  /' <<<"$plists"; else echo "  (none)"; fi

  echo "launchd jobs in ${GUI_DOMAIN} matching NI:"
  launchctl list | grep -iE "$NI_PATTERN" | sed 's/^/  /' || echo "  (none)"

  echo "Agent processes:"
  local name pid any=0
  for name in "${AGENT_NAMES[@]}"; do
    for pid in $(pgrep -x "$name" || true); do
      echo "  ${name} (pid ${pid})"
      any=1
    done
  done
  [[ $any -eq 1 ]] || echo "  (none running)"

  local apps
  apps="$(running_ni_apps)"
  if [[ -n "$apps" ]]; then
    echo "NI apps running (they will restart the agents):"
    sed 's/^/  /' <<<"$apps"
  fi
}

stop() {
  local apps
  apps="$(running_ni_apps)"
  if [[ -n "$apps" ]]; then
    echo "Quit these NI apps first, they would restart the agents:" >&2
    sed 's/^/  /' <<<"$apps" >&2
    exit 1
  fi

  local plist
  while IFS= read -r plist; do
    [[ -n "$plist" ]] || continue
    echo "launchctl bootout ${GUI_DOMAIN} ${plist}"
    launchctl bootout "$GUI_DOMAIN" "$plist" 2>/dev/null || true
  done < <(ni_plists)

  local name
  for name in "${AGENT_NAMES[@]}"; do
    if pgrep -x "$name" >/dev/null; then
      echo "Stopping ${name}"
      pkill -TERM -x "$name" || true
    fi
  done

  local i
  for i in 1 2 3 4 5; do
    [[ -z "$(agent_pids)" ]] && break
    sleep 1
  done
  for name in "${AGENT_NAMES[@]}"; do
    if pgrep -x "$name" >/dev/null; then
      echo "${name} ignored SIGTERM, sending SIGKILL"
      pkill -KILL -x "$name" || true
    fi
  done

  # Agents sometimes come back on their own; check once more after a short wait.
  sleep 2
  if [[ -n "$(agent_pids)" ]]; then
    echo "Warning: an NI agent restarted itself:" >&2
    status >&2
    exit 1
  fi
  echo "NI hardware agents stopped."
}

start() {
  local plist
  while IFS= read -r plist; do
    [[ -n "$plist" ]] || continue
    echo "launchctl bootstrap ${GUI_DOMAIN} ${plist}"
    launchctl bootstrap "$GUI_DOMAIN" "$plist" 2>/dev/null || true
  done < <(ni_plists)

  local name app
  for name in "${AGENT_NAMES[@]}"; do
    app="${AGENT_DIR}/${name}.app"
    if pgrep -x "$name" >/dev/null; then
      echo "${name} already running"
    elif [[ -d "$app" ]]; then
      echo "Starting ${name}"
      open -g -a "$app"
    fi
  done
}

case "${1:-}" in
  stop) stop ;;
  start) start ;;
  status) status ;;
  *)
    echo "Usage: $0 stop|start|status" >&2
    exit 2
    ;;
esac
