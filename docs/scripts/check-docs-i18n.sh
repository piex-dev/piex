#!/usr/bin/env bash
# Thin wrapper — real logic in check_docs_i18n.py (bash 3.2 compatible).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec python3 "$ROOT/docs/scripts/check_docs_i18n.py" "$@"
