# Afterbook — working conventions

This repo is **the Next.js app** (`app/`, `lib/`, `middleware.ts`, etc.),
deployed to Vercel as afterbook.app. See `README.md` for what it does and
why; that file is the product/architecture reference, not this one.

`lib/` is grouped by feature (2026-11-04); put a new module in the folder of what it serves:

| Folder | What lives there |
| --- | --- |
| `lib/swap/` | In-app swaps (real money): KyberSwap build and checks, the request guard, the swap log, meme and basket buys |
| `lib/lending/` | Aave and Morpho reads, the in-app Aave borrow and lend maths and calls (real money), liquidation and loan-health maths |
| `lib/baskets/` | Basis Tilt on Glider (real money): the Glider client, weights, the tilt job |
| `lib/wallet/` | Wallet setup: wagmi config, the Builder Code suffix, Basenames |
| `lib/market/` | Prices and pools: the tape, quotes, depth, liquidity lines, the NY session clock, history, volatility, swap simulation, the /today snapshot |
| `lib/stocks/` | Which tokens exist and their data: `tokens.ts` (`STOCKS`), Coinbase's list and icons, discovery, earnings, corporate actions, symbol colours, /stocks |
| `lib/lp/` | LP positions and range maths: My Lots, fee APR, gauge yield |
| `lib/build/` | `/build` custom baskets: the spec in the URL and its cost |
| `lib/memes/` | Memestocks: the verified pool allowlist and formatting |
| `lib/share/` | Share cards and link previews: the card image, metadata, snapshots, share text |
| `lib/alerts/` | Telegram alerts and the in-page toasts |
| `lib/server/` | Server plumbing: Redis, rate limits, the shared-secret check, region lookup, x402, the click log |
| `lib/format.ts`, `lib/brand.ts` | Shared number formatting and the logo |

`app/components/` is grouped the same way (2026-11-04):

| Folder | What lives there |
| --- | --- |
| `home/` | The Trade home page (`TradeHome.tsx`) |
| `swap/` | The swap panel and its shared wallet steps (`useSwapWallet.ts`), slippage, Portfolio's router approvals (real money) |
| `lending/` | The in-app Aave borrow and lend panels and the loan calculator (real money) |
| `baskets/` | Basis Tilt's deposit panel and `/build`'s basket picker, buy and sell (real money) |
| `memes/` | The memestock board and meme buy panel (real money) |
| `markets/` | The `/markets` page (`HomeClient.tsx` and its sections), the tape, charts and `/stocks` |
| `portfolio/` | My Lots |
| `notifications/` | Toasts, the bell and the live alerts |
| `layout/` | Header, ticker strip, theme, the wallet button, the logo |
| `ui/` | Small shared pieces: symbol tiles, token icons, the Share button, the session pill |

Styles are one stylesheet per area in `app/styles/` (2026-11-04), loaded in a fixed order by `app/globals.css`: tokens, base, ui, layout, notifications, markets, stocks, memes, baskets, lending, swap, home, then `overrides.css` (touch targets, phone field sizes, reading text), which must stay last. **Order decides ties**, so a new rule goes in the file of the area it styles, and a rule meant to beat other areas goes in `overrides.css`. When splitting was done, every element's computed style on every page (desktop and phone, both themes) was compared with the single file before it: identical.

## Verifying changes

No lint script yet. CI (`.github/workflows/ci.yml`) runs `npm run typecheck`, `npm test` and `npm run build` on every PR and push to `main`, with no secrets. To verify a change actually works:
- `npm test` — Vitest unit tests in `tests/` for the swap money path (`checkSwapCalldata` tamper cases, `parseSwapRequest`, `swapFee`, the $25k and pool-depth caps, `guardSwapRequest`), plus a few others (the Aave borrow maths, the token-list split and the discovery digest's "Skipped" part). Offline: KyberSwap, the chain, Redis and the region lookup are mocked, so tests never touch production Redis. A change to `lib/swap/swap.ts` or `lib/swap/swapGuard.ts` keeps or extends them.
- `npm run build` — typecheck + Next.js build. Not a correctness test.
- For API routes (especially `app/api/v1/x402/*`), hit them for real:
  `curl -s -i https://afterbook.app/api/<route>` and read the response —
  a 402 response's `payment-required` header is base64 — decode it
  (`| base64 -d`) to check `payTo`/`amount`/etc. rather than trusting the
  empty `{}` body.
- For anything UI-facing, actually load it in a browser — this app has
  real on-chain reads (pool state, wallet balances) that a build/typecheck
  pass can't catch.

## Baskets / Glider (real money)

`/baskets` runs on Glider's B2B API (`lib/baskets/glider.ts`, `lib/baskets/*`,
`app/api/baskets/*`). Read the "Baskets (Basis Tilt)" section of
`README.md` first.

- **There is no staging.** Glider's B2B API is production-only; the key
  in `.env.local` and Vercel is a production tenant key and every write
  is real. Test with a separate private strategy (the 3-token test
  strategy pattern) and tiny amounts.
- **Never publish a strategy version, trigger a rebalance, or sign/
  submit a withdrawal on the user's behalf without their explicit
  instruction in that turn.** A publish makes *every enrolled portfolio*
  trade. Check how many portfolios are enrolled and their balances
  first (see the `basis-tilt-ops` skill). The permission classifier may
  block real-money calls — don't route around it; explain and hand the
  step to the user (the `!` prefix runs a command as them).
- **`BASKET_AUTOPUBLISH` is ON** (owner decision, 2026-10-07, set in Vercel Production, with the publish threshold raised to 10% first; evidence in the `basis-tilt-ops` skill). The nightly job (22:00 UTC) can now publish a new version, which makes every enrolled portfolio trade, and messages the owner when it does. Don't lower `MIN_TURNOVER` or change the weighting without redoing the replay, and turn the switch off (unset the variable, redeploy) if anything looks wrong. Production env changes and deploys may be blocked by this session's permission check: don't work around it, hand the step to the user.
- **The basket universe is `BASKET_SYMBOLS` in `lib/baskets/tilt.ts`,
  not `STOCKS`.** Adding a token to `lib/stocks/tokens.ts` must not change what
  enrolled users hold. Widening the basket is a separate, explicit
  decision (and a new strategy version).
- Env values are pasted by hand and have broken things twice (stray
  spaces around a strategy id; `<`/`>` placeholders around a key). The
  Glider client trims them; still check shape without printing the
  value. Never print, log or paste `GLIDER_API_KEY`.
- **Two API keys, by design** (rotated 2026-10-02): the production key
  lives only in Vercel; the local `.env.local` key is **read-only**
  (`strategies:read`, `portfolios:read`, `enroll:write`), so local
  scripts can read and dry-run but cannot publish or withdraw. Keys can
  only be created/revoked in the Glider console (no API for it). Rotation
  steps are in the `basis-tilt-ops` skill. Never ask the user to paste a
  key into the session; use hidden `read -s` prompts in their own
  terminal.
- **Wallet connect on phones relies on `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`** (public id, set in Vercel Production; the code leaves the phone-friendly wallets out without it). Don't remove it, and re-check what "Connect wallet" opens on a phone (since 2026-11-03 a two-item list, Base Account then WalletConnect, whose entry opens the All Wallets window) after touching `lib/wallet/wagmiConfig.ts` or the CSP in `middleware.ts` (see the `verify` skill).
- Don't name Glider or use their logo beyond what is already on the
  site without the user confirming; the wording ("run on", not "powered
  by") is deliberate.

## UI conventions

- Tokens, not hard-coded colours: dark values on `:root`, light on
  `:root[data-theme='light']` in `app/styles/tokens.css`. New surfaces use the
  existing variables so both themes work. Colour roles (owner, 2026-10-19): green and red only for market movement and financial status; `--info` (neutral) for explanations and system states such as notices; the accent for links, the primary button and what is selected (the selected tape row and card get a 7% accent tint, the hero's Onchain price card an accent edge). New inline links that must
  look like links use `.emph-link`, and end-of-page "go to" links use `.page-link`, which looks the same plus an arrow (one link style, owner decision 2026-10-12). The footer links (Token, Pool…) use the same look, and X, GitHub, README the same minus the underline until hovered (owner decision 2026-10-14); only the header nav stays a quiet menu (owner decision, same day); buttons in a row use `.basket-row`
  style gaps, never `<br>`/inline spaces.
- **One button system** (owner decision, 2026-10-05): every action is a pill, 44px tall, 14px semi-bold: solid `.btn` (primary) or outline `.btn btn-secondary`. That includes "Size a trade", Share, the Copy buttons, Execute, Baskets, and the header/panel "Connect wallet" (`.wallet-connect-btn`) and wallet panel buttons, which match it. Don't add a new button class or a different radius/size; reuse `.btn`. Inputs, selects and the size chips are data controls and keep their 12px corners, except the Baskets amount box, which sits in a row of pills and is a pill too; icon buttons are 44px circles. The swap panel's Buy / Sell switch and the home card's Swap / Borrow / Lend tabs (`.swap-side-toggle`) are a segmented pill whose segments are 44px (the pill 48px), 14px semi-bold; the Carry calculator's switch stays the small quiet one. Every tap target is at least 44px and text at least 12px (2026-11-03, checked in WebKit: Safari ignores `min-height` on a native select, so selects draw their own arrow, and gives a `<button>` an 11px font unless it sets `font: inherit`); inline links inside a sentence are the exception. To check "aligned", compare computed height, font and radius across pages, not how they look.
- Verify UI in a **real browser** and in **both themes and at a real
  390px phone viewport** — a narrow desktop window is not one. See the
  `verify` skill for the headless recipe and what can't be driven
  (wallet modal).
- User-visible counts ("ten stocks") go stale when the tracked list
  changes. After adding/removing a token, grep for them (see the
  `add-tokenized-stock` skill).
- **Share cards and link previews:** one route, `app/card/route.tsx`, draws every card (`/card?page=…&sym=…&theme=light&v=N`); pages point their `og:image`/`twitter:image` at it through `shareMetadata` (`lib/share/shareMeta.ts`) and the Share panel's "Download card" uses the same URL. After changing `lib/share/ogImage.tsx`, bump `CARD_VERSION` in `lib/share/cardUrl.ts` (`.claude/skills/card-version-bump/bump.sh`, and `bump.sh --check` before the PR), otherwise X/Telegram keep the old card for unstamped links. Shared links carry `s` (the share's snapshot id: the server froze the tape when Share was clicked, and the post's sentence and the card both come from that snapshot, `lib/share/shareSnapshot.ts`), `theme` (the sharer's) and, on `/today`, `sym` (the stock on screen); never let a card take its numbers from the URL; don't strip them, and never block them in `robots.txt`: X's crawler obeys it and a `Disallow: /*?s=` left every shared link without a card until 2026-10-13. Light and dark card colours are `PALETTES` in `lib/share/ogImage.tsx` (from the tokens in `app/styles/tokens.css`).
- **Builder Code on every transaction:** any transaction the app asks a wallet to send must pass `dataSuffix: BUILDER_CODE_SUFFIX` (`lib/wallet/builderCode.ts`) per call; the wagmi config-level setting does not reach `useWriteContract` (wevm/wagmi #5248). Today that is the Baskets USDC deposit, the swap panel's approval and swap, the `/build` basket buy's and sell's approvals and swaps, a meme buy's approval and swap, Portfolio's Revoke (`approve(router, 0)`, `RouterApprovals.tsx`), the in-app Aave loan's approvals (spender: the spoke), `multicall`, `repay` and `withdraw` (`AaveBorrowPanel.tsx`), and the in-app lending's USDC approval, `supply` and `withdraw` (`AaveLendPanel.tsx`) (`sendTransaction` has no `dataSuffix`, so the swap appends it with `concat`). Don't remove it; add it to any new transaction.
- **In-app swaps** (`lib/swap/swap.ts`, `app/api/swap/*`, `SwapPanel.tsx`, `MemeBuyPanel.tsx`, the wallet steps all four panels (and Portfolio's Revoke, `RouterApprovals.tsx`) share in `app/components/swap/useSwapWallet.ts` (exact approval, router swap, Builder Code, rebuild rules), and basket buys and sells on `/build`: `BasketBuyPanel.tsx`, `BasketSellPanel.tsx`, `lib/swap/basketBuy.ts`; real money): KyberSwap builds the transaction and `checkSwapCalldata` must pass before the browser sees it (router, tokens, recipient = the connected wallet, amount, minimum within the trader's slippage limit (`slippageBps`, 0.1–1%, default 0.5%, owner 2026-11-03; same for memes; don't widen the range without the owner), fee, no permit). Approvals are for the exact amount and only the router `KYBER_ROUTER`, never unlimited. A stock buy is capped at the lower of $25k and 10% of its live pool depth (`MAX_BUY_DEPTH_SHARE` in `lib/swap/swap.ts`, owner 2026-10-27). Don't loosen a check, add a token outside `STOCKS` (meme buys use only the verified `memes:pools` allowlist through `lib/swap/memeSwap.ts`: buy only, $10k live liquidity floor, USDC or that meme's stock token, $1,000 cap, never a fee) or turn the fee on (`SWAP_FEE_BPS`) without the owner; the fee stays 0 until the legal check. After changing any of it, rerun the tamper test and the fake-wallet browser test (`verify` skill) and the `real-money-reviewer`.
- **In-app borrowing** (`/borrow#borrow-here`, `AaveBorrowPanel.tsx`, `lib/lending/aaveBorrow.ts`; real money; owner 2026-11-03): Aave V4's MAG7 spoke only (Morpho's stock markets had ~$3k to lend), borrow / repay / withdraw collateral, up to the protocol limit less 0.5% (owner chose the protocol limit), $25,000 per borrow, same region and eligibility gates as trading. Approvals are exact and name the **spoke** (it pulls the tokens; verified in the deployed source), every call is `onBehalfOf` the signer and carries the Builder Code, and the panel pauses if a reserve's token or the oracle stops matching. Don't add a position manager, an unlimited approval, a call for someone else, or Morpho without re-checking liquidity and asking the owner; rerun the simulations and the fake-wallet test (`verify` skill) and the `real-money-reviewer` after any change. **In-app lending** (`/borrow#lend-here`, `AaveLendPanel.tsx`; owner 2026-11-03): USDC into the same spoke's USDC reserve and back, $25,000 per deposit, same gates, exact approval of the spoke, `onBehalfOf` the signer; withdrawals at most what the pool has free. Same rules apply.
- **Memestocks are not stocks:** `/memes` lists meme tokens from their own allowlist (`memes:pools`, written by the `discover-memes` job, `lib/memes/memestocks.ts`); never add one to `STOCKS` or `BASKET_SYMBOLS`, and never present one as recommended (sort by volume or move). The warning above every meme price ("Any memecoin can go to zero…") is not dismissable. A pool is listed only if it passes the on-chain check described in README; don't loosen it to list more.
- **Pools: Aero and Aerodrome** (2026-10-27): each stock in `STOCKS` points at its deepest USDC pool, and `pool.factory` says which CL factory made it: `AERO_CL_FACTORY` (Aero, Aerodrome's successor since 2026-10-22; 20 stocks) or `CL_FACTORY` (the older one; 18). Aero pools charge a dynamic fee, so any fee maths uses `poolFeePpm(state, stock)` (the live `fee()` in `PoolState`), never `stock.pool.feePpm` alone; Aero has no Sugar and pays a new AERO token, so `lib/lp/gaugeYield.ts` returns null for Aero pools; My Lots reads LP positions from each factory's position manager (Sugar returned nothing after the upgrade) and still shows positions in the 12 stocks' old pools (`LEGACY_POOLS` in `lib/lp/lots.ts`, display only, never in `STOCKS`). Fee-APR snapshots are keyed by pool address. Discovery and the meme check accept both factories; don't drop one without checking where the liquidity is.
- **Naming the exchange** (owner, 2026-10-27): general copy says "Aero" (the definitions say "Aero (formerly Aerodrome)" once); copy about one stock uses `poolVenue(stock)` ("Aero" or, for a pool on the older factory, "Aerodrome"); links that open aerodrome.finance and the older-pool note in My Lots keep "Aerodrome".
- **Labels come from data, not the clock:** never label a price "pre-market"/"after-hours" from the session state alone; use each row's `cashPriceType` (the hero, the card and the tape header/note all do). Two labels for one price was a real contradiction.
- **Home page = Trade tab** (owner, 2026-11-03, from an external review; `app/page.tsx`, `TradeHome.tsx`): a heading and one sentence on what the site is, the US market's state, the five deepest stocks (Base price, the real stock's, the gap as a percent, a Buy button that fills the card) and one action card with Swap, Borrow and Lend tabs. Swap is the in-app swap (`SwapPanel`) behind the same eligibility checkbox, ticked for every trade (owner, same day). Borrow links to the in-app Aave loan on `/borrow#borrow-here` (2026-11-03) and Morpho's own site; Lend links to the in-app USDC deposit on `/borrow#lend-here` (2026-11-03) and Aave's site. Two columns from 901px with the card sticky on the right (the "Real stock" column hides at 901–1099px and under 421px), one column at 900px and narrower. The card opens on the day's biggest liquid gap (same pick as `/today`). The tape, the calculators and the hero with the gap sentence moved to `/markets` (`HomeClient.tsx`, its sections in `app/components/markets/`, also every `/<SYMBOL>` page); its hero must still say the gap as one plain sentence (name, percent and bp, versus what, when cash reopens), define "Onchain price" and "100 bp = 1%" once, with the three-step strip and the closed "What the words mean" (owner OK 2026-10-28). The tape's main list shows every pool of at least $250k (`TAPE_MAIN_DEPTH_USD`, display only; the $1M liquid line still decides everything else). Reading text (notes, explanations, toasts, footer prose) is 14px; labels, table headers, the ticker and chips stay compact. Don't repeat the same numbers in several blocks above the fold.
- **Owner decisions on the look** (don't undo without asking): the
  header "Connect wallet" is solid, like the ones inside the trade, basket and My Lots panels (owner, 2026-11-03; outlined from 2026-10-19 until then), and Base Account is first in the wallet list; its pill shape is the app-wide button shape; the scrolling
  ticker stays on every page; the wallet button opens an account panel
  rather than disconnecting on click. Navigation is five tabs (owner, 2026-11-03; `SiteHeader.tsx`): Trade (`/`), Markets (`/markets`, also active on `/today`, `/stocks` and every stock page), Borrow, Portfolio (`/portfolio`, the wallet's positions, which left the tape page, and since 2026-11-03 what KyberSwap's router may still spend from it with a Revoke button, `RouterApprovals.tsx`) and More (`/more`: baskets, build, memestocks, Telegram, how it works, API; also active on those pages). Desktop shows them in the header; at 900px and narrower they sit in a bar fixed to the bottom of the screen (it replaced the menu panel) and the header is one row (logo, wallet, bell, theme) that scrolls away: the wallet drops its "Base" label
  there, and below 421px the logo keeps only its mark. A "↗" after a link is joined with
  `&nbsp;` and wrapped in `<span className="ext-arrow">` (a little extra space), so it never wraps onto a line of its own: `&nbsp;<span className="ext-arrow">↗</span>`. Notes (`.geo-note`) have no width cap and fill their panel at every width (owner, 2026-10-19).

## Working process

- The full checklist is the `ship-and-verify` skill.
- Before opening a PR that touches Glider, the baskets, the deposit panel, the swap (`lib/swap/swap.ts`, `app/api/swap/*`, `app/components/swap/useSwapWallet.ts`, `SwapPanel.tsx`, `MemeBuyPanel.tsx`, `RouterApprovals.tsx`, `AaveBorrowPanel.tsx`, `AaveLendPanel.tsx`, `lib/lending/aaveBorrow.ts`, `BasketBuyPanel.tsx`, `BasketSellPanel.tsx`, `lib/swap/basketBuy.ts`), a wallet transaction, or the secrets/permission setup, run the read-only `real-money-reviewer` subagent (`.claude/agents/real-money-reviewer.md`) on the diff and act on its findings. If a check in it stops being true (a new route, a new guard), update the agent file in the same PR.
- Branch → PR → merge only when the user asks → wait for the Vercel
  deploy → verify the **live** site (curl, and a real browser for
  anything client-rendered; the ticker strip, for example, is empty in
  the server HTML by design).
- Gate commits and PRs on a passing build (`npm run build … && git
  commit`), and check any external link you add actually resolves to the
  right thing (a Telegram bot's display name is not its username).
- Keep README, this file and the skills in step with the code in the
  same PR as the change. A doc that says something false is worse than
  none.

## Secrets and deploy safety

- Never type or paste a private key into this session. Any command that
  touches a raw key (a contract deploy, `cast wallet import`) must be run
  by the user in their own terminal — walk them through it, don't run it
  yourself even if asked to.
- Cron routes, `/api/clicks/stats` and the Telegram webhook check their
  shared secret through
  `lib/server/sharedSecret.ts` (`cronAuthorized`, `secretMatches`), which refuses
  every call in a built deployment if the secret is unset (open only under
  `next dev`). New cron or webhook
  routes use it too; never `if (secret) { check }`, which is open when unset.
- `.env.example` (tracked) lists every variable the code reads, with no
  values. Add a new variable there in the same PR; never put a real value in
  it. All other `.env*` files stay ignored.
- The x402 payout address (`X402_PAYOUT_ADDRESS`, the owner's Coinbase
  Smart Wallet `0x9b3F…6Bae` since 2026-10-13) is a **public** wallet/
  contract address, not a secret — safe to read, discuss, and propose
  values for directly, unlike the CDP API keys or Redis/Telegram tokens.
- Vercel production changes (env var edits, `vercel deploy --prod`) are
  gated by this session's permission classifier and may get denied even
  after the user has approved the underlying action in chat. If a
  `vercel env rm/add` or similar gets blocked, don't work around it —
  explain what was being attempted and offer the dashboard-UI path (same
  pattern used for the CDP keys) or ask the user to grant a Bash
  permission rule.
- Before any push: confirm nothing suspicious is staged (env files,
  scratch files, anything holding a key): `git status` after a broad
  `git add`, and spot-check the diff.

## Permission rules (`.claude/settings.json`, checked in)

The "never do this on your own" rules above are also enforced as permission rules, so they don't depend on remembering them:
- **Always asks first:** `vercel deploy --prod`, `vercel env add/rm/pull`, `gh pr merge`, and any `curl` to `/api/cron/basket-tilt` (including the `?dry=1` form, which is read-only; just approve it).
- **Denied outright:** `cast wallet` (raw keys), and any `curl` to `/api/cron/alerts` or `/api/telegram/webhook` (they would act on the shared production Redis and Telegram).
- An ask rule beats an allow, so `.claude/settings.local.json` allowing `vercel deploy*` does not skip the production prompt.
- Limits: these match the command text, so a different tool (`wget`, a script) is not covered. Don't use that to get around a rule; hand the step to the user.
- **Secrets hook** (`.claude/hooks/guard-secrets.sh`, a PreToolUse hook in the same file): blocks Read/Edit/Write of any `.env*` file (except `.env.example`) and Bash that reads one with `cat`/`grep`/`sed` and the like, or prints a secret variable (`echo $…KEY|SECRET|TOKEN`, `printenv`, bare `env`). Sourcing is fine. To check a value exists, source it and test `[ -n "$NAME" ]`, printing only yes/no (use `bash -c`: `${!v}` does not work in zsh). It matches command text only, so a script that prints a secret is not caught; that is still on you. **False positive to expect:** it scans the whole Bash command, heredocs and commit/PR messages included, so text that mentions an env file next to a word like `cat` or `grep` gets blocked. Write such text with the Edit/Write tools and pass it with `git commit -F` / `gh pr create --body-file`.

## Redis (Upstash) request budget

Upstash bills per request, and the free plan's 500k-a-month cap was hit on 2026-10-18, which took swaps, Baskets and Share down with 500s (moved to pay-as-you-go the same day). Keep Redis off hot paths: nothing per tape build (every 20 s per warm instance) may call Redis uncached; history samples are written only by the 5-minute alerts cron (`recordTapeSamples`); rate limiters (`lib/server/ratelimit.ts`, `SafeLimiter`) fall back to an in-memory count when Redis errors, and the polled read routes (`/api/lots`, quote, depth, history…) use the in-memory `MemoryLimiter` only (`limitRead`, `lib/server/readGuard.ts`); a new public route that spends chain reads gets `limitRead` too; and bookkeeping writes (the swap log) never fail the request. A page that reads Redis wraps the read in Next's data cache (`unstable_cache`, as `/stocks` does), so views don't each cost a request. `/api/tape` (no Redis, but a chain read and a Yahoo call per stock) is also held at Vercel's edge for 10 s plus 20 s stale-while-revalidate on success. A local `next dev` with `.env.local` uses the same Redis and counts too.

## Vercel project

Linked project: `gregs-projects-c49a01b8/afterbook`. `vercel env ls`
(optionally `production`) to check current values before changing
anything. Use the `vercel-env-verify` skill for the full
change-then-confirm sequence — an env var change alone does **not**
redeploy, so skipping the redeploy+verify steps leaves the live site
silently serving the old value.
