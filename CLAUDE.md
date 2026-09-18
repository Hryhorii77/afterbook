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
