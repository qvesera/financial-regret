#!/usr/bin/env bash

set -euo pipefail

# ─────────────────────────────────────────────
# killport.sh — Force kill process on a port
# Usage: ./killport.sh <port>
# ─────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

if [[ $# -ne 1 ]]; then
  echo -e "${YELLOW}Usage:${RESET} $0 <port>"
  exit 1
fi

PORT="$1"

# Validate that the input is a number
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [[ "$PORT" -lt 1 || "$PORT" -gt 65535 ]]; then
  echo -e "${RED}Error:${RESET} '$PORT' is not a valid port number (1–65535)."
  exit 1
fi

# Find PIDs listening on the given port
PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)

if [[ -z "$PIDS" ]]; then
  echo -e "${CYAN}No process found listening on port ${PORT}.${RESET}"
  exit 0
fi

echo -e "${YELLOW}Found process(es) on port ${PORT}:${RESET}"
for PID in $PIDS; do
  PROC_NAME=$(ps -p "$PID" -o comm= 2>/dev/null || echo "unknown")
  echo -e "  ${CYAN}PID ${PID}${RESET} — ${PROC_NAME}"
done

# Kill each PID
for PID in $PIDS; do
  if kill -9 "$PID" 2>/dev/null; then
    PROC_NAME=$(ps -p "$PID" -o comm= 2>/dev/null || echo "unknown")
    echo -e "${GREEN}✔ Killed PID ${PID}${RESET} (${PROC_NAME})"
  else
    echo -e "${RED}✘ Failed to kill PID ${PID}${RESET} — try running with sudo."
  fi
done

echo -e "${GREEN}Done. Port ${PORT} is now free.${RESET}"
