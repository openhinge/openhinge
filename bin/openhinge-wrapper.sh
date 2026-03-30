#!/bin/bash
# Wrapper for openhinge CLI — catches crashes and provides self-healing update
set -e

# Find install root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR"
# Walk up to find package.json (handles both bin/ and dist/bin/)
for i in 1 2 3; do
  [ -f "$ROOT/package.json" ] && break
  ROOT="$(dirname "$ROOT")"
done

# If the command is "update", do it in pure shell first to avoid broken binary
if [ "$1" = "update" ]; then
  echo "Updating OpenHinge..."
  cd "$ROOT"
  git fetch origin 2>/dev/null
  git checkout -- package-lock.json 2>/dev/null || true
  git pull --ff-only origin main
  npm install --production=false --silent 2>&1 | tail -1
  npm run build 2>&1 | tail -1
  echo "Update complete. $(node -e "console.log('v' + require('./package.json').version)" 2>/dev/null || echo '')"

  # Re-link
  npm link --silent 2>/dev/null || sudo npm link --silent 2>/dev/null || true

  # Restart server if running
  PID=$(lsof -ti:3700 2>/dev/null || true)
  if [ -n "$PID" ]; then
    echo "Restarting server..."
    kill $PID 2>/dev/null || true
    sleep 1
    nohup node "$ROOT/dist/src/index.js" > "$ROOT/data/openhinge.log" 2>&1 &
    echo "Server restarted (PID $!)"
  fi
  exit 0
fi

# Try running the Node CLI — if it crashes, offer recovery
ENTRY="$ROOT/dist/bin/openhinge.js"
if [ ! -f "$ENTRY" ]; then
  echo "OpenHinge not built. Building..."
  cd "$ROOT" && npm run build 2>&1 | tail -1
fi

node "$ENTRY" "$@" 2>/dev/null
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  # Node binary crashed — try rebuilding
  echo ""
  echo "OpenHinge CLI crashed. Attempting self-repair..."
  cd "$ROOT"
  git pull --ff-only origin main 2>/dev/null || true
  npm install --production=false --silent 2>&1 | tail -1
  npm run build 2>&1 | tail -1
  echo "Rebuilt. Retrying..."
  node "$ENTRY" "$@"
fi
