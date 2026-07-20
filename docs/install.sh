#!/usr/bin/env bash
# PieX — one-command install all packages
#
# Usage:
#   curl -fsSL https://piex.dev/install.sh | bash          # global install (npm)
#   curl -fsSL https://piex.dev/install.sh | bash -s -- -l  # project-local install (npm)
#   bash docs/install.sh --dev                              # local dev install (repo paths)
#   bash docs/install.sh --dev -l                           # local dev + project-level
#
# Prerequisites: pi (https://pi.dev), Node.js >= 18
set -euo pipefail

# ── Color helpers ──────────────────────────────────────
RED="$(printf '\033[0;31m')"
GREEN="$(printf '\033[0;32m')"
YELLOW="$(printf '\033[1;33m')"
DIM="$(printf '\033[2m')"
RESET="$(printf '\033[0m')"

# ── Usage ──────────────────────────────────────────────
usage() {
  cat <<EOF
PieX install script — install all @piex-dev/* packages at once.

Usage:
  curl -fsSL https://piex.dev/install.sh | bash          # global install (npm)
  curl -fsSL https://piex.dev/install.sh | bash -s -- -l  # project-local install (npm)
  bash docs/install.sh --dev                              # local dev install (repo paths)
  bash docs/install.sh --dev -l                           # local dev + project-level

Options:
  -l, --local   Install project-locally (.pi/settings.json)
  --dev         Install from local packages/ directory (repo development)
  -h, --help    Show this help

Prerequisites: pi CLI (https://pi.dev), Node.js >= 18
EOF
  exit "${1:-0}"
}

LOCAL_FLAG=""
USE_DEV=false

for arg in "$@"; do
  case "$arg" in
    -l|--local) LOCAL_FLAG="-l" ;;
    --dev) USE_DEV=true ;;
    -h|--help) usage ;;
    *) echo -e "${RED}Unknown option: $arg${RESET}" >&2; usage 1 ;;
  esac
done

# ── All PieX packages ──────────────────────────────────
# Order: hashline first (has npm deps), then core tools, then experience packages.
PACKAGES=(
  hashline
  dap
  lsp
  plan
  review
  init
  theme-dark-terminal
  xai-oauth
  btw
  context
)

# ── Pre-flight checks ──────────────────────────────────
echo ""
echo -e "${DIM}PieX install script${RESET}"
echo -e "${DIM}──────────────────────${RESET}"

# Check pi CLI
if ! command -v pi &>/dev/null; then
  echo ""
  echo -e "${RED}pi CLI not found.${RESET}"
  echo ""
  echo "Install pi first:"
  echo "  npm install -g @earendil-works/pi-coding-agent"
  echo ""
  echo "Docs: https://pi.dev"
  exit 1
fi

PI_VERSION="$(pi --version 2>/dev/null || echo 'unknown')"
echo -e "${DIM}pi version:${RESET} $PI_VERSION"

# Check Node.js
if ! command -v node &>/dev/null; then
  echo -e "${RED}Node.js not found. pi requires Node.js >= 18.${RESET}"
  exit 1
fi

NODE_VERSION="$(node -v 2>/dev/null | sed 's/^v//' || echo '0')"
echo -e "${DIM}node version:${RESET} v$NODE_VERSION"

# ── Dev mode: locate repo root ─────────────────────────
if [[ "$USE_DEV" == true ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  # If running from docs/install.sh, repo root is one level up
  if [[ -d "$SCRIPT_DIR/../packages" ]]; then
    REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  else
    echo -e "${RED}Cannot find packages/ directory.${RESET}"
    echo "Run this script from the piex repo, or set PACKAGES_DIR:"
    echo "  PACKAGES_DIR=/path/to/piex/packages bash docs/install.sh --dev"
    exit 1
  fi

  PACKAGES_DIR="${PACKAGES_DIR:-$REPO_ROOT/packages}"
  if [[ ! -d "$PACKAGES_DIR" ]]; then
    echo -e "${RED}Packages directory not found: $PACKAGES_DIR${RESET}"
    exit 1
  fi

  echo -e "${DIM}mode:${RESET} dev (local paths)"
  echo -e "${DIM}packages dir:${RESET} $PACKAGES_DIR"

  # hashline: install runtime deps locally
  HASHLINE_DIR="$PACKAGES_DIR/hashline"
  if [[ -d "$HASHLINE_DIR" ]] && [[ ! -d "$HASHLINE_DIR/node_modules" ]]; then
    echo -e "${DIM}Installing hashline runtime dependency (@oh-my-pi/hashline)...${RESET}"
    (cd "$HASHLINE_DIR" && npm install --omit=dev 2>&1 | tail -1)
  fi
else
  echo -e "${DIM}mode:${RESET} npm registry"
fi

SCOPE="global"
if [[ -n "$LOCAL_FLAG" ]]; then
  SCOPE="project-local (.pi/settings.json)"
fi
echo -e "${DIM}install scope:${RESET} $SCOPE"

# ── Install ────────────────────────────────────────────
echo ""
echo -e "${DIM}Installing ${#PACKAGES[@]} packages...${RESET}"
echo ""

TOTAL=${#PACKAGES[@]}
SUCCESS=0
FAILED=()

for i in "${!PACKAGES[@]}"; do
  pkg="${PACKAGES[$i]}"
  if [[ "$USE_DEV" == true ]]; then
    SOURCE="$PACKAGES_DIR/$pkg"
  else
    SOURCE="npm:@piex-dev/$pkg"
  fi

  printf "  [%2d/%2d] %-25s " "$((i + 1))" "$TOTAL" "$SOURCE"

  if pi install ${LOCAL_FLAG:+"$LOCAL_FLAG"} "$SOURCE" >/dev/null 2>&1; then
    echo -e "${GREEN}✓${RESET}"
    ((++SUCCESS))
  else
    echo -e "${RED}✗${RESET}"
    FAILED+=("$pkg")
  fi
done
# ── Summary ────────────────────────────────────────────
echo ""
echo -e "${DIM}──────────────────────${RESET}"
printf "Installed: ${GREEN}%d${RESET} / %d\n" "$SUCCESS" "$TOTAL"

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo ""
  echo -e "${RED}Failed packages:${RESET}"
  for pkg in "${FAILED[@]}"; do
    echo "  - $pkg"
  done
  echo ""
  echo -e "${YELLOW}Tip:${RESET} try installing failed packages individually:"
  if [[ "$USE_DEV" == true ]]; then
    echo "  pi install $PACKAGES_DIR/<name>"
  else
    echo "  pi install npm:@piex-dev/<name>"
  fi
  exit 1
fi

echo ""
echo -e "${GREEN}All PieX packages installed.${RESET}"
echo -e "Run ${YELLOW}pi list${RESET} to verify, or check out https://piex.dev for docs."
