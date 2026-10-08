# AAI Mobile

Offline iPhone app (installable PWA): price check, customer lookup and follow-ups from one encrypted bundle exported by the AAI Console (read-only), plus capture of leads, quotes/orders and follow-up notes into an outbox on the phone.

## Standing rule

Azure is read-only, permanently. No feature in any version of the AAI Console or the phone app ever writes to Azure. Never add INSERT, UPDATE, DELETE, a commit, or a writable connection.

The phone app never talks to Azure at all, and never makes any network request after it is installed, except loading its own files.

## Why this repo is public

Public only because free GitHub Pages needs it. The repo is CODE ONLY: no customer data, no prices, no company records. `*.aaib` and `phone-test/` are gitignored, and a test fails if the repo contains any `.aaib` file or any JSON file over 100 KB. All test fixtures are small synthetic data. The real data exists only inside the encrypted bundle on the phone.

## Install on iPhone

1. Open the Pages URL in **Safari** (not Chrome or an in-app browser): https://michael17651.github.io/aai-mobile/
2. Tap **Share**, then **Add to Home Screen**, then **Add**.
3. Open it from the Home Screen icon. After the first load it opens offline.

## Import a bundle

1. In the console: Saved intake, Admin, **Export phone bundle**. Choose a passphrase (8+ characters). It downloads `aai-phone-bundle-YYYYMMDD.aaib`.
2. **AirDrop** the file to the phone, and tap **Save to Files** (or save it from Mail/Messages into the Files app).
3. In AAI Mobile tap **Import a bundle file**, pick the file in Files, type the bundle passphrase, tap Open bundle.
4. The app decrypts it in memory and re-computes every price check. You see a green "Prices verified, N checks", or a red "Price check failed, do not quote from this phone" (the price screens stay closed).
5. It then asks you to **choose a PIN** (4 to 8 digits, typed twice). That is the last time the bundle passphrase is needed on this phone.

**Re-import:** do the same with a newer file; it replaces the stored bundle and asks for a PIN again. The header warns amber after 7 days and red after 30 days from the bundle date, so re-import when it turns amber.

**Updating from an older version:** a phone that already holds a bundle from before PINs asks for the bundle passphrase once on first open, then walks through choosing a PIN.

## Lock model (read this)

- The bundle is stored on the phone encrypted with a random AES-GCM data key. That key is wrapped by a key derived from your PIN (PBKDF2-SHA256, 600,000 iterations, random salt) and stored in IndexedDB. Neither the PIN nor the bundle passphrase is stored.
- **The PIN is a screen lock.** A 4 to 8 digit PIN can be guessed offline by anyone who copies the app's storage off the phone. The real protection is the **iPhone passcode and iPhone device encryption**. Keep a strong passcode.
- **5 wrong PINs in a row delete the stored bundle** (and its outbox passphrase) and show "Too many wrong PINs. Import the phone bundle again with its passphrase." After each wrong PIN you wait 1, 2, 4, then 8 seconds. The count lives in IndexedDB and resets on a correct PIN. Unexported outbox records are not bundle data and are kept.
- The app locks at every cold start, after 5 minutes idle, and with the Lock button, wiping decrypted data from memory and returning to the PIN screen.
- **Settings** (top bar): Change PIN (asks for the current PIN), the Outbox passphrase (set; Show after re-entering the PIN), and Delete bundle from this phone (asks first; keeps the outbox).
- Version and cache name (`Version 2.1.0 · cache aai-mobile-v6`) show on the lock screen and in Settings. When a new version finishes installing while the app is open, an "Update ready, tap to reload" bar appears. The service worker fetches the app files with `cache: 'reload'`, so GitHub Pages' 10 minute cache cannot serve a stale copy.

**Safari storage caveat:** if you use it as a plain Safari tab (not added to the Home Screen), Safari may delete site storage, including the saved bundle, after 7 days without use. The Home Screen app is not subject to that. If the saved bundle is gone, import the file again.

The customer **Maps** button is a plain link to Google Maps (`https://www.google.com/maps/search/?api=1&query=<url-encoded address>`): it opens the Google Maps app if installed, otherwise Google Maps in Safari. It is only opened when tapped; the app itself loads nothing from the network.

## Layout, quantity and customer list

The page itself never scrolls: a fixed `100dvh` column (top bar, banner, one scrolling region, tab bar) with safe-area insets, so the bars stay put under the status bar and home indicator, and the keyboard or rubber-band bounce cannot move them. The price/customer search boxes stay pinned above the scrolling results.

On **Prices**, each card has a Quantity box (whole numbers 1 to 9999). It highlights the tier row and shows unit price and line total from the same engine as quotes (Master Panda boards pool their quantities, with the free-board credit noted); call-for-price items say "Call for price". Quantities are kept while the app is unlocked and cleared on Lock.

**Customers** lists everyone sorted by name when the search is empty ("N customers"), 50 rows at a time (more on scroll or "Show more"); typing filters live.

## Capture and outbox

The **New** tab captures a lead/new customer (with "met at" and hot/warm/cold), a quote request or order (catalog lines priced with the same engine as Price check; call-for-price items show "Call for price", never $0), or a follow-up note (for a customer or a lead on the phone). Each is saved to the **Outbox** (IndexedDB on the phone, count badge on the tab) and can be edited or deleted until exported. Nothing is sent by the app.

**Outbox, Export** uses the **Outbox passphrase** (8+ characters, typed twice once: in Settings or on your first export). It is stored on the phone under the PIN, so later exports need no typing; read it in Settings (Show, after re-entering the PIN) when the console asks for it. Export encrypts all unexported records into `aai-outbox-YYYY-MM-DD-HHMM.aaio` (same crypto and layout as `.aaib`, format unchanged), and opens the iOS share sheet (or offers a download). Records are marked exported only after the share finishes or you tap "I sent it", and stay listed for 30 days so a lost file can be re-exported. The outbox is customer data: it is stored unencrypted on the phone (iOS device encryption applies; the PIN lock only hides it from the screen), and `*.aaio` is gitignored and test-checked. The JSON format is in CLAUDE.md.

## Bundle format (version 1)

UTF-8 JSON `{v:1, salt, iv, ct}` (base64). AES-GCM 256, key = PBKDF2-SHA256, 600,000 iterations over the UTF-8 passphrase, `ct` has the 16-byte tag appended. Decrypted: `version, createdAt, priceListDate, customers[], catalog[], followUps[], checks[], rules`. Price rules come from `rules`: title add per board for the listed titles, every Nth Master Panda board free at the average billed price, Master Panda quantities pooled for the tier. Items with no tiers, or a non-positive tier price, show "Call for price", never $0. Each catalog item carries `ta` (boolean) from the console export: the Title picker on New quote lines shows only for `ta === true`. A bundle with no `ta` on any item hides the picker everywhere and the Price check and New screens say "Re-export the phone bundle to enable title add".

Layout: the shell is `position:fixed; inset:0` (no `100dvh`, which left a gap under the tab bar on iOS); html, body and the tab bar share the dark background and the bar carries its own `padding-bottom: env(safe-area-inset-bottom)`.

## Files

`index.html`, `styles.css`, `core.js` (crypto, pricing, self-check, search), `app.js` (UI), `sw.js` (offline shell cache, uncached fetches), `manifest.webmanifest`, icons. System fonts only, no CDN, no external requests.

## Tests

`npm install && npm test` (node + jsdom + fake-indexeddb, real WebCrypto). To ship an app change to phones, bump `CACHE` in `sw.js`.
