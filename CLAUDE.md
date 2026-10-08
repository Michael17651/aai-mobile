# AAI Mobile

Offline iPhone PWA (version 1, read-only) for the AAI Console's encrypted phone bundle. Public repo (free GitHub Pages needs it): CODE ONLY, no customer data, no prices, no company records. Never commit \`*.aaib\`, \`*.aaio\` or \`phone-test/\`; the test suite fails on any .aaib or JSON over 100 KB. Fixtures are small synthetic data. No network requests after install except the app's own files; no CDN, no external fonts.

## Standing rule

Azure is read-only, permanently. No feature in any version of the AAI Console or the phone app ever writes to Azure. Never add INSERT, UPDATE, DELETE, a commit, or a writable connection.

The phone app never talks to Azure at all.

Run tests: \`npm test\`. Bump \`CACHE\` in \`sw.js\` when shipping app changes.

## Capture and outbox (phone app version 2.0.0)

The phone can capture leads, quote requests/orders and follow-up notes. They are saved only in IndexedDB on the phone (store `outbox`) and leave only as an encrypted `.aaio` file that the user shares. The app never sends anything over the network. Never commit an `.aaio` (gitignored; the repo-safety test fails on one). Treat the outbox as customer data.

### `.aaio` file layout (same as `.aaib`)

UTF-8 JSON `{"v":1,"salt","iv","ct"}`, base64 fields. AES-GCM 256, key = PBKDF2-SHA256, 600,000 iterations over the UTF-8 passphrase, 16-byte salt, 12-byte iv, `ct` has the 16-byte tag appended. File name `aai-outbox-YYYY-MM-DD-HHMM.aaio` (phone local time).

### Decrypted JSON

```
{
  "version": 1,
  "createdAt": ISO timestamp of the export,
  "deviceLabel": string (user-set, default "iPhone"),
  "records": [ record, ... ]
}
```

Every record has: `id` (crypto.randomUUID, unique, stable across re-exports; use it to de-duplicate on import), `kind` ("lead" | "order" | "quote" | "followup"), `createdAt` (ISO), `appVersion` (string), and `updatedAt` (ISO, only if edited). Unset text fields are empty strings. The phone's `exportedAt` bookkeeping is never in the file. The same record can arrive in more than one file (re-export): import by `id`.

**lead** (new customer or lead): `company, contact, phone, email, address, city, state, zip, metAt` (show or site name), `temp` ("hot" | "warm" | "cold"), `notes`.

**order / quote** (`kind` "order" or "quote" = quote request):
```
customer: { "existing": true,  "key", "name", "city", "state", "zip" }      // key = bundle customer key (not unique: twins share a key; match with name + zip)
        | { "existing": false, "company", "contact", "phone", "email", "address", "city", "state", "zip" }
lines: [ { "name": catalog name, "qty": int >= 1, "unitPrice": number|null, "lineTotal": number|null,
           "callForPrice": bool, "title": string|null, "priceListDate": string } ]
promo: [ negative numbers ]      // free-board credit(s), from the bundle rules
titleAdd: [ positive numbers ]   // title-add charge(s)
total: number | null             // null when every line is call-for-price
totalExcludesCallItems: bool     // true when any line is call-for-price (its price is NOT in total)
priceListDate: string            // bundle priceListDate used for the pricing
notes: string
```
A call-for-price line has `unitPrice` and `lineTotal` null and `callForPrice` true; it is never $0. Pricing is the Price check engine (tiers, Master Panda pooling, free board, title add); `total` = sum of `lineTotal` + `promo` + `titleAdd`.

**followup**:
```
target: { "type": "customer", "key", "name", "city", "state", "zip" } | { "type": "lead", "id": id of a lead record, "name" }
note: string, due: "YYYY-MM-DD"
```

### Phone behavior

Records are editable/deletable until exported. Export asks for the passphrase twice (8+ chars), builds the file, then shares it (iOS share sheet) or offers a download. Records are marked exported only after the share completes or the user taps "I sent it", and then stay visible for 30 days for re-export. Lock and the 5-minute idle lock empty all screens, including New and Outbox.

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
