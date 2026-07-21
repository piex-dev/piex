#!/usr/bin/env bash
# Publish all @piex-dev/* packages from extensions/ prompts/ themes/.
#
# Packages are discovered dynamically by pi type directory; private packages
# (e.g. ai-code-report, internal registry deps) are skipped automatically.
#
# Requires: npm login, and publish rights on the @piex-dev org (whoami alone is not enough).
# On failure, continue to the next package (version already published etc).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# pi package types → top-level directories. hashline first (has runtime npm dep),
# then the rest. Order within each dir is alphabetical.
TYPE_DIRS=(extensions prompts themes)

if ! npm whoami >/dev/null 2>&1; then
  echo "Not logged in to npm. Run: npm login"
  exit 1
fi

FAILED=()
PUBLISHED=()
SKIPPED=()

is_private() {
  # private:true in package.json → skip (node exits 0 if private, 1 if not)
  node -e "const p=require('./package.json');process.exit(p.private?0:1)" 2>/dev/null
}

for dir in "${TYPE_DIRS[@]}"; do
  for pkgdir in "$ROOT/$dir"/*/; do
    [[ -f "$pkgdir/package.json" ]] || continue
    name=$(node -e "process.stdout.write(require('$pkgdir/package.json').name || '')" 2>/dev/null)
    pkgname=$(basename "$pkgdir")
    if (cd "$pkgdir" && is_private); then
      echo ">>> SKIP $name ($dir/$pkgname is private)"
      SKIPPED+=("$name")
      continue
    fi
    echo ">>> Publishing $name ..."
    if (cd "$pkgdir" && npm publish); then
      echo ">>> OK $name"
      PUBLISHED+=("$name")
    else
      echo ">>> FAILED $name (continuing)"
      FAILED+=("$name")
    fi
    echo
  done
done

echo
echo "Published: ${#PUBLISHED[@]}  Skipped (private): ${#SKIPPED[@]}  Failed: ${#FAILED[@]}"
if [[ ${#FAILED[@]} -eq 0 ]]; then
  echo "All publishable packages published."
else
  echo "Failed: ${FAILED[*]}"
  exit 1
fi
