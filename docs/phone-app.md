# Phone app

Current state notes for the phone app. Rationale is in `decisions.md`; hard rules are in `../CLAUDE.md`. The console side of the bundle is documented in `~/projects/aai-console/docs/phone-app.md`.

## Phase 11 success criteria: stock view

- The Prices tab has a read-only stock view that mirrors the console's Price check stock panel: same grouping (the Group select follows the price list's links to stock codes), same zero-row rule, same wording.
- The stamps line reads "Inventory sheet saved <date-time> · snapshot made <date-time>", formatted like "Oct 13, 2026, 3:27 PM".
- When the snapshot was made more than one day ago the view shows "Stock is from <date>. Re-export from the console for current numbers." (tested with a fake clock).
- A linked code that is not on the inventory sheet shows "Not on the inventory sheet" and no numbers.
- A bundle with no `stock` field imports and opens as before; the stock view says "No stock snapshot in this bundle."
- The stock view makes no network request and writes nothing; lock empties it like every other screen.
- `UnitCost` and `VendorID` are never read or shown.
