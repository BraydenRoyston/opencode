---
name: dev-channels
description: How to build, test, and ship changes to opencode itself on this machine without breaking the user's work instance. Use whenever editing code in ~/repos/opencode or relaunching/upgrading opencode.
---

# Dev channels

This machine runs opencode from source with two isolated channels. Never mix them up:

| Command | Channel | Checkout | Moves when |
| --- | --- | --- | --- |
| `opencode` | **stable** — the user's real work instance | `/Users/braydenroyston/repos/opencode-stable` | Only via `opencode-update` |
| `opencode-dev` | **dev** — live working tree | `/Users/braydenroyston/repos/opencode` | Every save |

## Rules

- **Never treat `opencode` as your test target.** It powers the user's daily work. Test everything with `opencode-dev`.
- Hack freely anywhere in `/Users/braydenroyston/repos/opencode`; the stable checkout cannot see it.
- Stable advances only by explicit promotion. Do not run `opencode-update` casually, and never run it to "fix" a broken dev experiment.

## Workflow for changes to opencode

1. Edit in `/Users/braydenroyston/repos/opencode` (work on a branch; default branch is `dev`).
2. After dependency changes, run `bun install` at the repo root.
3. Verify before asking anyone to run it:
   - `bun run typecheck` from the affected package dir (never `tsc` directly)
   - tests from the package dir (`bun test`), e.g. `packages/tui`, `packages/opencode`
   - functional check: launch `opencode-dev` (tmux + `capture-pane` works well for TUI checks)
4. Open a PR against `dev` and let the user review/merge.
5. Promotion to the work instance happens only when the user runs `opencode-update`
   (fast-forwards stable to `origin/dev`, rolls back automatically if install or
   smoke check fails).

## Notes

- Both wrappers preserve `$PWD` internally so project detection works; do not
  bypass them with raw `bun run src/index.ts` calls.
- Both channels share `~/.local/share/opencode` (sessions, database, auth).
  Stable only moving forward keeps this safe; downgrading stable below a dev
  schema migration can break it.
- These paths describe this machine's setup. If the checkouts move, update the
  wrappers in `~/.opencode/bin/` and this file together.
