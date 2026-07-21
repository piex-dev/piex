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
  --dev         Install from local extensions/ prompts/ themes/ (repo development)
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

# ── All PieX packages (discovered by pi type dir) ──────
# Top-level dirs: extensions/ (TS), prompts/ (prompt), themes/ (theme).
# Private packages (e.g. ai-code-report) are skipped.
# Discovery is alphabetical within each dir, so hashline is NOT first in the
# install loop — but that's fine: its runtime dep is installed separately
# (below) before the loop runs.
TYPE_DIRS=(extensions prompts themes)

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

# ── Locate repo root (needed for package discovery in BOTH modes) ──
# We discover packages from the repo so we can skip private ones; registry mode
# installs them via npm:@piex-dev/<name>, dev mode via local path.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -d "$SCRIPT_DIR/../extensions" ]]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
elif [[ "$USE_DEV" == true ]]; then
  echo -e "${RED}Cannot find extensions/ directory.${RESET}"
  echo "Run this script from the piex repo, or set REPO_ROOT:"
  echo "  REPO_ROOT=/path/to/piex bash docs/install.sh --dev"
  exit 1
else
  # registry mode from outside the repo: no local discovery, fall back to full list
  REPO_ROOT=""
fi

# ── Build install list (discovered by pi type dir; skip private) ──
is_private_pkg() {
  node -e "const p=require('$1/package.json');process.exit(p.private?0:1)" 2>/dev/null
}

PACKAGES=()
PKG_PATHS=()
FAILED=()
SUCCESS=0

for dir in "${TYPE_DIRS[@]}"; do
  for pkgdir in "$REPO_ROOT/$dir"/*/; do
    [[ -f "$pkgdir/package.json" ]] || continue
    # in registry mode we still want to skip private packages
    if is_private_pkg "${pkgdir%/}"; then continue; fi
    name=$(node -e "process.stdout.write(require('${pkgdir}package.json').name || '')" 2>/dev/null)
    # strip @piex-dev/ scope for the short label / npm:@piex-dev/<name> form
    short="${name#@piex-dev/}"
    PACKAGES+=("$short")
    PKG_PATHS+=("$dir/$short")
  done
done

# Fallback: registry mode run from OUTSIDE the repo (no local discovery) →
# use the full published list (all non-private @piex-dev packages).
if [[ ${#PACKAGES[@]} -eq 0 ]]; then
  PACKAGES=(hashline dap lsp plan review init theme-dark-terminal xai-oauth btw context)
  PKG_PATHS=()
fi

TOTAL="${#PACKAGES[@]}"

if [[ "$USE_DEV" == true ]]; then
  echo -e "${DIM}mode:${RESET} dev (local paths)"
  echo -e "${DIM}repo:${RESET} $REPO_ROOT"

  # hashline: install runtime deps locally
  HASHLINE_DIR="$REPO_ROOT/extensions/hashline"
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
    SOURCE="$REPO_ROOT/${PKG_PATHS[$i]}"
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
  if [[ "$USE_DEV" == true ]]; then
    echo "  pi install $REPO_ROOT/extensions/<name>   (or prompts/<name> / themes/<name>)"
  else
    echo "  pi install npm:@piex-dev/<name>"
  fi
fi

echo ""
echo -e "${GREEN}All PieX packages installed.${RESET}"
echo -e "Run ${YELLOW}pi list${RESET} to verify, or check out https://piex.dev for docs."
