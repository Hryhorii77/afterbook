# Afterbook — working conventions

This repo holds **two independent projects** that must never be treated as
one:

1. **The Next.js app** (root — `app/`, `lib/`, `middleware.ts`, etc.) —
   deploys to Vercel as afterbook.app. See `README.md` for what it does and
   why; that file is the product/architecture reference, not this one.
2. **`contracts/jensen-buyback-burn/`** — a standalone Foundry project.
   Different toolchain, different deploy path, no shared config. See its
   own `CLAUDE.md` and `README.md`. **Never let it leak into the Next.js
   build** — `tsconfig.json`'s `exclude` and the root `.vercelignore` both
   deliberately exclude `contracts/`; a vendored Foundry `lib/` tree full
   of `.ts` scripts broke `npm run build` once already when those weren't
   in place. If either exclusion is ever removed, expect the build to
   break again the moment `contracts/*/lib/` is populated locally.

## Verifying changes

No lint script, no test suite. To verify a change actually works:
- `npm run build` — this repo's only automated check (typecheck +
  Next.js build). Not a correctness test.
- For API routes (especially `app/api/v1/x402/*`), hit them for real:
  `curl -s -i https://afterbook.app/api/<route>` and read the response —
  a 402 response's `payment-required` header is base64 — decode it
  (`| base64 -d`) to check `payTo`/`amount`/etc. rather than trusting the
  empty `{}` body.
- For anything UI-facing, actually load it in a browser — this app has
  real on-chain reads (pool state, wallet balances) that a build/typecheck
  pass can't catch.

## Baskets / Glider (real money)

`/baskets` runs on Glider's B2B API (`lib/glider.ts`, `lib/baskets/*`,
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
- **`BASKET_AUTOPUBLISH` stays off** unless the user says otherwise.
- **The basket universe is `BASKET_SYMBOLS` in `lib/baskets/tilt.ts`,
  not `STOCKS`.** Adding a token to `lib/tokens.ts` must not change what
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
- Don't name Glider or use their logo beyond what is already on the
  site without the user confirming; the wording ("run on", not "powered
  by") is deliberate.

## UI conventions

- Tokens, not hard-coded colours: dark values on `:root`, light on
  `:root[data-theme='light']` in `app/globals.css`. New surfaces use the
  existing variables so both themes work. New inline links that must
  look like links use `.emph-link`; buttons in a row use `.basket-row`
  style gaps, never `<br>`/inline spaces.
- **One button system** (owner decision, 2026-10-05): every action is a pill, 44px tall, 14px semi-bold: solid `.btn` (primary) or outline `.btn btn-secondary`. That includes "Size a trade", Share, the Copy buttons, Execute, Baskets, and the header/panel "Connect wallet" (`.wallet-connect-btn`) and wallet panel buttons, which match it. Don't add a new button class or a different radius/size; reuse `.btn`. Inputs, selects and the size chips are data controls and keep their 12px corners; icon buttons are 44px circles. To check "aligned", compare computed height, font and radius across pages, not how they look.
- Verify UI in a **real browser** and in **both themes and at a real
  390px phone viewport** — a narrow desktop window is not one. See the
  `verify` skill for the headless recipe and what can't be driven
  (wallet modal).
- User-visible counts ("ten stocks") go stale when the tracked list
  changes. After adding/removing a token, grep for them (see the
  `add-tokenized-stock` skill).
- **Labels come from data, not the clock:** never label a price "pre-market"/"after-hours" from the session state alone; use each row's `cashPriceType` (the hero, the card and the tape header/note all do). Two labels for one price was a real contradiction.
- **First screen:** the hero must say the gap as one plain sentence a
  stranger can repeat (name, bp, versus what, when cash reopens), define
  "Aero" and "100 bp = 1%" once, and carry one primary button. Don't
  repeat the same numbers in several blocks above the fold. The home page
  opens on the day's biggest liquid gap (same pick as `/today`).
- **Owner decisions on the look** (don't undo without asking): the
  header "Connect wallet" stays the solid primary button and its pill shape is the app-wide button shape; the scrolling
  ticker stays on every page; the wallet button opens an account panel
  rather than disconnecting on click.

## Working process

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
  touches a raw key (contract deploys, `cast wallet import`) must be run
  by the user in their own terminal — walk them through it, don't run it
  yourself even if asked to.
- The x402 payout address (`X402_PAYOUT_ADDRESS`) is a **public** wallet/
  contract address, not a secret — safe to read, discuss, and propose
  values for directly, unlike the CDP API keys or Redis/Telegram tokens.
- Vercel production changes (env var edits, `vercel deploy --prod`) are
  gated by this session's permission classifier and may get denied even
  after the user has approved the underlying action in chat. If a
  `vercel env rm/add` or similar gets blocked, don't work around it —
  explain what was being attempted and offer the dashboard-UI path (same
  pattern used for the CDP keys) or ask the user to grant a Bash
  permission rule.
- Before any push: confirm nothing suspicious is staged, especially
  broadcast/deploy artifacts from the Foundry project (`git status`
  after a broad `git add`, spot-check diffs). Real (non-dry-run) Foundry
  broadcast records are meant to be committed — see the contracts
  project's `.gitignore` comment — but check their contents don't
  contain a raw key before staging (they shouldn't; `forge script`
  doesn't write one there, but verify rather than assume).

## Vercel project

Linked project: `gregs-projects-c49a01b8/afterbook`. `vercel env ls`
(optionally `production`) to check current values before changing
anything. Use the `vercel-env-verify` skill for the full
change-then-confirm sequence — an env var change alone does **not**
redeploy, so skipping the redeploy+verify steps leaves the live site
silently serving the old value.
