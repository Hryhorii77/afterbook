---
name: ship-and-verify
description: Ship a change to afterbook end to end - branch, build gate, commit, PR, then (only when the owner says merge) merge, wait for the Vercel deploy by polling the live site for the change itself, and verify live. Use whenever a change is ready to commit, open as a PR, merge, or confirm live. Never merges on its own.
---

# Ship a change and verify it live

This is the loop the owner and I run for every change: **branch, PR, the
owner says merge, deploy, verify the live site.** It encodes the mistakes
we already made (a PR merged into the wrong base, a deploy "Ready" that was
still the old one, a message blocked by the secrets hook). Rules that apply
throughout are in the root `CLAUDE.md`; this is the order of operations.

## 1. Preflight

```bash
git status --short && git branch --show-current
```

- Work on a branch, never on `main`. `git checkout -b <short-name>` from an
  up-to-date `main` (`git checkout main && git pull`).
- Remove stale generated types before building or committing:
  `rm -rf .next/types`.
- Stop any local `next start` / proxy you started for testing (`pkill -f
  "next start"`) once you are done with it.

## 2. Keep docs in step (same PR)

README, `CLAUDE.md` and the skills must say what the code now does. A doc
that says something false is worse than none. If the change touches
`lib/ogImage.tsx`, bump `// Card version N` in all six card route files; if
it adds a wallet transaction, it must pass `dataSuffix: BUILDER_CODE_SUFFIX`;
if it changes the tracked list, grep for stale counts (see
`add-tokenized-stock`).

## 3. Build gate

`npm run build` must pass before any commit. It is the only automated check
(typecheck plus Next.js build), and it is **not** a correctness test: for UI,
load it in a real browser (both themes, a real 390px phone viewport; see the
`verify` skill). A change that is only docs or config may skip the build, but
say so in the PR.

## 4. Commit and open the PR

- `git add` named paths, then `git status --short` and read it. Nothing from
  `contracts/` broadcast folders, no env files, no scratch files.
- **Write the commit message and the PR body to files** (with the Write
  tool) and use `git commit -F <file>` and `gh pr create --body-file <file>`.
  The secrets hook scans the whole Bash command and blocks text that mentions
  an env file next to a word like `cat` or `grep`.
- End the commit message with the attribution trailer and the PR body with
  the attribution line given in the session's system reminder.
- PR body: what changed and why; **Verified** (what you actually ran and saw);
  **Not verified** (say it plainly); docs touched.
- `--base main` explicitly. Check `gh pr view <n> --json baseRefName`.

## 5. Stop and ask

Report the PR link and ask whether to merge. **Do not merge until the owner
says to in that turn.** Merging is also gated by a permission prompt
(`gh pr merge`), so expect one confirmation.

## 6. Merge (only on the owner's word)

- Merge **one PR at a time**, and confirm its base is `main` first. Merging a
  PR with `--delete-branch` while another PR is stacked on it closes the
  stacked one (this happened with #48/#49).
- `gh pr merge <n> --merge --delete-branch`, then `gh pr view <n> --json
  state` must say `MERGED`; then `git checkout main && git pull`.
- Never run `vercel deploy --prod` to "speed it up": the merge deploys by
  itself, and production deploys are gated.

## 7. Wait for the deploy by polling the change itself

Do **not** trust "Ready" in `vercel ls`: it twice showed the previous deploy
as Ready. Poll the live site for something only the new code produces, in a
loop of 10-15 second sleeps, giving up after a few minutes:

- new text or a unique string: fetch the page's script files and search them
  (`curl -s https://afterbook.app/<page> | grep -o '/_next/static/[^"]*\.js'`,
  then `curl -s` each and `grep -q "<unique string>"`);
- a new route or header: `curl -s -o /dev/null -w "%{http_code}"`;
- a changed card image: the `?hash` in the page's `og:image` tag.

A foreground command stops at about two minutes. Keep one poll loop under
that, or run it in the background and read its output file.

## 8. Verify live and report

- Status codes of `/`, `/baskets`, `/today` (and the pages the change touches).
- Anything client-rendered (ticker, charts, wallet panel, toasts) needs a real
  browser against `https://afterbook.app`, not `curl`.
- For real-money or wallet changes, say exactly what was and wasn't tested
  (a fake wallet that rejects the transaction proves the calldata, not a
  mainnet send).
- Final message: what is live, what was verified how, what is not verified and
  what the owner can do to check it. Do not claim more than you saw.

## Never, in this loop

- Call `/api/cron/alerts` or `/api/telegram/webhook` (denied by a rule), or
  the basket cron without `?dry=1` (the local env shares production Redis).
- Publish a strategy version, rebalance, or sign a withdrawal: see
  `basis-tilt-ops` and the owner's explicit instruction.
- Change a production env var without `vercel-env-verify`.
