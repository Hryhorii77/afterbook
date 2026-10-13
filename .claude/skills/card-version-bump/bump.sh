#!/usr/bin/env bash
# Share-card version: CARD_VERSION in lib/cardUrl.ts rides in every card URL (`&v=N`), and
# X / Telegram cache a card per URL. Bump it whenever lib/ogImage.tsx changes.
#   bump.sh          N -> N+1
#   bump.sh --check  exit 1 if lib/ogImage.tsx differs from main but CARD_VERSION is not higher
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILE=lib/cardUrl.ts
read_version() { grep -oE '^export const CARD_VERSION = [0-9]+;' | grep -oE '[0-9]+' || true; }

current=$(read_version < "$FILE")
if [ -z "$current" ]; then
  echo "No 'export const CARD_VERSION = N;' line in $FILE" >&2
  exit 1
fi

if [ "${1:-}" = "--check" ]; then
  if git diff --quiet main -- lib/ogImage.tsx; then
    echo "lib/ogImage.tsx is unchanged from main: no bump needed (CARD_VERSION $current)."
    exit 0
  fi
  base=$( (git show "main:$FILE" 2>/dev/null || true) | read_version)
  base=${base:-0}
  if [ "$current" -gt "$base" ]; then
    echo "OK: lib/ogImage.tsx changed and CARD_VERSION went $base -> $current."
    exit 0
  fi
  echo "NOT BUMPED: lib/ogImage.tsx changed but CARD_VERSION is still $current (main: $base). Run bump.sh." >&2
  exit 1
fi

next=$((current + 1))
sed -i.bak -E "s/^export const CARD_VERSION = [0-9]+;/export const CARD_VERSION = $next;/" "$FILE" && rm -f "$FILE.bak"
echo "CARD_VERSION $current -> $next in $FILE"
