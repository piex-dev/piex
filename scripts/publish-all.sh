#!/usr/bin/env bash
# Publish all @piex-dev/* packages from packages/
#
# Requires: npm login, and publish rights on the @piex-dev org (whoami alone is not enough).
# On failure, continue to the next package (version already published etc).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)/packages"
FAILED=()
ROOT="$(cd "$(dirname "$0")/.." && pwd)/packages"
PACKAGES=(hashline dap lsp plan review init theme-dark-terminal xai-oauth btw context)

for p in "${PACKAGES[@]}"; do
  echo ">>> Publishing @piex-dev/$p ..."
  if (cd "$ROOT/$p" && npm publish); then
    echo ">>> OK @piex-dev/$p"
  else
    echo ">>> FAILED @piex-dev/$p (continuing)"
    FAILED+=("$p")
  fi
  echo
done

if [[ ${#FAILED[@]} -eq 0 ]]; then
  echo "All packages published."
else
  echo "Published with ${#FAILED[@]} failure(s): ${FAILED[*]}"
  exit 1
fi

for p in "${PACKAGES[@]}"; do
  echo ">>> Publishing @piex-dev/$p ..."
  (cd "$ROOT/$p" && npm publish)
  echo ">>> OK @piex-dev/$p"
  echo
done

echo "All packages published."
