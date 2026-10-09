#!/bin/bash
# Share-card version helper. Every opengraph-image / twitter-image route file starts with
# "// Card version N." The image URL's ?hash depends only on that route file's text, so after
# lib/ogImage.tsx changes the number must change in ALL of them or X/Telegram keep the old card.
#   bump.sh          bump every card route file to the same next version
#   bump.sh --check  exit 1 if lib/ogImage.tsx differs from main but a card file was not bumped
cd "$(git rev-parse --show-toplevel)" || exit 1

files=()
while IFS= read -r f; do files+=("$f"); done < <(git ls-files | grep -E '(^|/)(opengraph|twitter)-image\.tsx$')
[ "${#files[@]}" -gt 0 ] || { echo "no card route files found" >&2; exit 1; }

ver() { sed -nE '1s|^// Card version ([0-9]+)\..*|\1|p'; }

missing=0
for f in "${files[@]}"; do
  [ -n "$(ver < "$f")" ] || { echo "no '// Card version N.' first line in $f" >&2; missing=1; }
done
[ "$missing" = 0 ] || exit 1

if [ "$1" = "--check" ]; then
  if git diff --quiet main -- lib/ogImage.tsx; then
    echo "lib/ogImage.tsx is unchanged from main: no bump needed (${#files[@]} card files)."
    exit 0
  fi
  bad=0
  for f in "${files[@]}"; do
    now=$(ver < "$f"); then_=$(git show "main:$f" 2>/dev/null | ver)
    if [ -z "$then_" ] || [ "$now" -gt "$then_" ]; then echo "ok      $f  ($then_ -> $now)"
    else echo "NOT BUMPED  $f  (still $now)"; bad=1; fi
  done
  [ "$bad" = 0 ] && echo "lib/ogImage.tsx changed and every card file was bumped." || echo "lib/ogImage.tsx changed: run bump.sh."
  exit "$bad"
fi

current=$(ver < "${files[0]}")
for f in "${files[@]}"; do
  [ "$(ver < "$f")" = "$current" ] || { echo "versions differ across card files; fix by hand first" >&2; exit 1; }
done
next=$((current + 1))
for f in "${files[@]}"; do
  perl -pi -e "s|^// Card version ${current}\\.|// Card version ${next}.| if \$. == 1" "$f"
  echo "$f: $current -> $next"
done
