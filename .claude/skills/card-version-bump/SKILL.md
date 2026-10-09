---
name: card-version-bump
description: Bump the share-card version after any change to lib/ogImage.tsx, so X and Telegram stop showing the old link-preview card. Use whenever lib/ogImage.tsx (the card layout, text or fonts) changes, before committing; also run its check before opening a PR.
---

# Share-card version bump

**Why:** the link-preview image URL is `/<route>/opengraph-image?<hash>`, and
the hash depends only on the text of that **route file**, not on
`lib/ogImage.tsx`, where the card is actually drawn. Change the card without
touching the route files and the URL (and its hash) stays the same, so X
(which caches a card per URL for about 7 days) and Telegram keep showing the
old card. Each route file therefore starts with `// Card version N.`; changing
that number changes the hash and busts the cache.

There are six such files (`app/`, `app/today/`, `app/[symbol]/`, each with an
`opengraph-image.tsx` and a `twitter-image.tsx`). All must carry the **same**
number, and **all** must change together.

## Do this after changing `lib/ogImage.tsx`

```bash
.claude/skills/card-version-bump/bump.sh          # 3 -> 4 in all six files
.claude/skills/card-version-bump/bump.sh --check  # exit 0 only if nothing is stale
```

- `bump.sh` finds the card files itself (`git ls-files`), refuses to run if
  one is missing the first-line comment or the numbers differ, and edits only
  line 1 of each.
- `--check` compares with `main`: if `lib/ogImage.tsx` differs and any card
  file is not higher than on `main`, it prints `NOT BUMPED` and exits 1. Run it
  before every PR that touches the card. It does nothing when the card is
  unchanged.
- A **new** `opengraph-image.tsx`/`twitter-image.tsx` must start with the same
  `// Card version N.` line (copy it from an existing one); the script will
  then include it automatically.

## After the deploy: confirm the hash really changed

```bash
for p in / /today /NVDAc; do printf "%-8s " "$p"; curl -s "https://afterbook.app$p" \
  | grep -oE 'property="og:image" content="[^"]*"' | head -1 | sed 's/property="og:image" content=//'; done
```

Each URL's trailing `?hash` must differ from the one before the change
(note the three before you merge). Also open each image URL and look at it:
the hash changing proves the URL changed, not that the card looks right.

## What this does not fix

- Cards already posted keep the old image on X until its cache expires or the
  post is re-shared with a new URL; the Share button adds a per-share `?s=`
  stamp for that, so new shares are fresh. Do not strip it.
- The card text itself comes from `lib/ogImage.tsx` and the data it reads;
  bumping the version never changes what is drawn.
