#!/usr/bin/env bash
# Publish all @piex-dev/* packages from packages/
#
# Requires: npm login, and publish rights on the @piex-dev org (whoami alone is not enough).
# On failure mid-run, earlier packages stay published; bump version before re-publishing those.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)/packages"
PACKAGES=(hashline dap lsp plan review init theme-dark-terminal xai-oauth btw context)

if ! npm whoami >/dev/null 2>&1; then
  echo "Not logged in to npm. Run: npm login"
  exit 1
fi

for p in "${PACKAGES[@]}"; do
  echo ">>> Publishing @piex-dev/$p ..."
  (cd "$ROOT/$p" && npm publish)
  echo ">>> OK @piex-dev/$p"
  echo
done

echo "All packages published."
