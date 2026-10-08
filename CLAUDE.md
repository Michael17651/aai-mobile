# AAI Mobile

Offline iPhone PWA (version 1, read-only) for the AAI Console's encrypted phone bundle. Public repo (free GitHub Pages needs it): CODE ONLY, no customer data, no prices, no company records. Never commit \`*.aaib\` or \`phone-test/\`; the test suite fails on any .aaib or JSON over 100 KB. Fixtures are small synthetic data. No network requests after install except the app's own files; no CDN, no external fonts.

## Standing rule

Azure is read-only, permanently. No feature in any version of the AAI Console or the phone app ever writes to Azure. Never add INSERT, UPDATE, DELETE, a commit, or a writable connection.

The phone app never talks to Azure at all.

Run tests: \`npm test\`. Bump \`CACHE\` in \`sw.js\` when shipping app changes.

## Usage-based auto-handoff

This repo has a git-based checkpoint system for Claude Code sessions,
replacing the old Tailscale/SSH/WSL remote-access setup.

**How it works:** `ccusage` (installed globally via `npm install -g ccusage`
— it's a Node CLI, not a `uv`/Python tool) reads live token usage for the
current 5h ccusage billing block from local transcript data. It has no
access to Anthropic's actual account rate-limit/quota numbers, so this is
still an approximation — just a token-based one instead of a wall-clock one.

- `PreToolUse` and `Stop` hooks (`.claude/hooks/handoff-check.sh`) call
  `ccusage blocks --active --json` on every tool call and read the active
  block's `totalTokens`. Every time cumulative usage in that block crosses a
  new 1,000,000-token increment since the last checkpoint (tracked in the
  gitignored `.claude/.last_checkpoint_tokens`), the hook:
  1. Stages and commits any pending work (`Auto-handoff: checkpoint at
     ~N tokens in current session block`).
  2. Writes `resume-note.md` with the last commit, working-tree status, and
     next steps.
  3. Commits `resume-note.md` and pushes.
  4. Records the new checkpoint baseline.
- This is **non-blocking** — it never stops the session or the tool call. It
  just leaves a trail of restore points so a checkpoint is never more than
  ~1M tokens stale. If the active block rolls over to a new 5h window, the
  hook detects the token count resetting lower and re-baselines instead of
  computing a bogus diff.
- `ccusage`'s npm global bin is not on this machine's PATH (a pre-existing
  custom npmrc prefix at `C:\home\mkpc\.npm-global`). The hook checks PATH
  first, then falls back to that known install path. If `ccusage` isn't
  reachable at all, the hook exits quietly rather than failing the tool call.

**Instruction for Claude:** after any auto-handoff commit (a commit message
starting with `Auto-handoff:`), run `git push` immediately if it hasn't
already gone out — the hook attempts a best-effort push itself, but treat an
unpushed auto-handoff commit as unfinished business at the start of your
next session.

**Resuming work:** start a new Claude Code session in this repo and read
`resume-note.md` first if it exists.
