---
name: card-version-bump
description: Bump the share-card version after any change to lib/ogImage.tsx, so X and Telegram stop showing the old link-preview card. Use whenever lib/ogImage.tsx (the card layout, colours, text or fonts) changes, before committing; also run its check before opening a PR.
---

# Share-card version bump

**How cards work (since 2026-10-13):** one route, `app/card/route.tsx`, draws
every card: `/card?page=home|stock|today|build&sym=…&spec=…&theme=light&s=…&v=N`.
Each page's `og:image`/`twitter:image` points at it (`lib/shareMeta.ts`), and the
share panel's "Download card" uses the very same URL (`ShareButton.tsx`), so the
preview, the download and the screen agree on the stock and the theme.
`lib/cardUrl.ts` builds the URLs.

**Why bump:** X caches a card per URL for about 7 days, Telegram too. `v=N` is
`CARD_VERSION` in `lib/cardUrl.ts`; change how a card looks without bumping it
and an unstamped link (e.g. a plain `afterbook.app/NVDAc` someone pastes) keeps
the old card.

## Do this after changing `lib/ogImage.tsx`

```bash
.claude/skills/card-version-bump/bump.sh          # CARD_VERSION N -> N+1
.claude/skills/card-version-bump/bump.sh --check  # exit 0 only if nothing is stale
```

`--check` compares with `main`: if `lib/ogImage.tsx` differs and `CARD_VERSION`
is not higher than on `main`, it prints `NOT BUMPED` and exits 1. Run it before
every PR that touches a card.

## After the deploy: confirm

```bash
for p in / /today /NVDAc '/today?s=test1&sym=NVDAc&theme=light'; do printf "%-40s " "$p"; curl -s "https://afterbook.app$p" \
  | grep -oE 'property="og:image" content="[^"]*"' | head -1 | sed 's/property="og:image" content=//'; done
```

Each URL must end in the new `v=N`, and the shared one must keep `sym` and
`theme`. Open the image URLs and look at them, in both themes: a new URL proves
nothing about how the card looks.

## Rules that keep previews working

- **Shared links must stay crawlable.** X's and Telegram's preview crawlers
  obey `robots.txt`. A `Disallow: /*?s=` there (until 2026-10-13) made every
  shared link show on X as a bare URL. Duplicates are handled by each page's
  canonical URL (`lib/shareMeta.ts`), never by robots.
- The card route lives outside `/api/`, which robots.txt disallows. Keep it
  there.
- `/today` shares carry `sym`: the card shows the stock the page showed, not
  the live leader (two names a few tenths of a bp apart swap the lead minute to
  minute; the card once showed AAPLc under a post about METAc).
- The theme is the sharer's (`theme=light` when they had light on), not the
  viewer's: a card is one PNG.
- `s` is a share's snapshot id (`lib/shareSnapshot.ts`): the card for that link
  draws from the tape frozen when Share was clicked, the same numbers as the
  post's sentence. Never take a card's numbers from the URL. Don't strip `s`:
  it also makes each share a new URL, so its
  card is fetched at share time with live numbers.
- New pages get their preview from `shareMetadata(...)`; a page that sets
  `openGraph` by hand without `images` loses its card.
