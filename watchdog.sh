#!/bin/bash
# Nelson Watchdog — monitors nelson.js and restarts on crash
# Run via: nohup bash ~/nelson/nelson/watchdog.sh &
# Or install as a cron: */2 * * * * bash ~/nelson/nelson/watchdog.sh check

set -euo pipefail

NELSON_DIR="$HOME/nelson/nelson"
PID_FILE="$NELSON_DIR/nelson.pid"
LOG_FILE="$NELSON_DIR/watchdog.log"
WATCHDOG_PID_FILE="$NELSON_DIR/watchdog.pid"
MAX_RESTARTS=5
RESTART_WINDOW=600  # 5 restarts in 10 minutes = give up

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Rotate watchdog log if > 1MB
if [ -f "$LOG_FILE" ] && [ "$(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null)" -gt 1048576 ]; then
  mv "$LOG_FILE" "$LOG_FILE.old"
fi

is_nelson_running() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  # Also check by process name
  if pgrep -f "node.*nelson\.js" > /dev/null 2>&1; then
    return 0
  fi
  return 1
}

start_nelson() {
  log "Starting Nelson..."
  cd "$NELSON_DIR"
  nohup node nelson.js >> "$NELSON_DIR/nelson_stdout.log" 2>&1 &
  local new_pid=$!
  sleep 2
  if kill -0 "$new_pid" 2>/dev/null; then
    log "Nelson started with PID $new_pid"
    return 0
  else
    log "ERROR: Nelson failed to start"
    return 1
  fi
}

# Check mode — called by cron, just checks and restarts if needed
if [ "${1:-}" = "check" ]; then
  if ! is_nelson_running; then
    log "WATCHDOG CHECK: Nelson is not running — restarting"
    start_nelson
  fi
  exit 0
fi

# Daemon mode — runs continuously
log "Watchdog daemon starting (PID $$)"
echo $$ > "$WATCHDOG_PID_FILE"

restart_times=()

cleanup() {
  log "Watchdog shutting down"
  rm -f "$WATCHDOG_PID_FILE"
  exit 0
}
trap cleanup SIGINT SIGTERM

while true; do
  if ! is_nelson_running; then
    now=$(date +%s)

    # Track restart frequency — bail if too many restarts
    restart_times+=("$now")
    # Keep only restarts within the window
    filtered=()
    for t in "${restart_times[@]}"; do
      if [ $((now - t)) -lt $RESTART_WINDOW ]; then
        filtered+=("$t")
      fi
    done
    restart_times=("${filtered[@]}")

    if [ ${#restart_times[@]} -gt $MAX_RESTARTS ]; then
      log "ERROR: Too many restarts (${#restart_times[@]} in ${RESTART_WINDOW}s) — watchdog backing off for 30 minutes"
      sleep 1800
      restart_times=()
      continue
    fi

    log "Nelson is down — restarting (attempt ${#restart_times[@]}/$MAX_RESTARTS in window)"
    start_nelson || log "Restart failed"
  fi

  sleep 30
done
