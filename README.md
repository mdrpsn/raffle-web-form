# Raffle slot form

A mobile-first web form for a numbered paddle raffle (default: 100 slots at ₱150).
Customers pick numbers on a live 1–100 board, enter their details, pay by
GCash/Maya/GoTyme and upload a screenshot. You approve payments from an admin page;
approved numbers turn **Secured** on the public board. Registration closes, paid
entries are frozen, and the draw runs from the frozen list.

```
AVAILABLE → PENDING (reserved, hold expires) → PAID (secured, after you approve)
```

**Cost: ₱0.** Front end on a free static host, backend on Google Sheets + Apps Script,
screenshots in your Google Drive.

```
web/        index.html (customers)  admin.html (you)  api.js  config.js  style.css
backend/    Code.gs  — paste into Apps Script
tests/      e2e.js   — browser test of the whole flow (demo mode)
```

## Try it now (demo mode, no setup)

`config.js` ships with an empty `API_URL`, so the site runs against fake data stored in
your own browser. Admin PIN in demo mode is `1234`.

```bash
python3 -m http.server 8765 --directory web     # then open http://localhost:8765
```

## Go live, free (about 15 minutes)

### 1. Backend — Google Sheet + Apps Script
1. Create a new Google Sheet (name it e.g. "Raffle 001").
2. **Extensions → Apps Script.** Delete the sample code, paste all of `backend/Code.gs`, save.
3. Pick the `setup` function in the toolbar → **Run**. Approve the permissions prompt
   (it needs the Sheet and Drive). This creates the `Config`, `Slots` and `Orders` tabs,
   a private Drive folder for screenshots, and an admin PIN. Open **Execution log** to
   read the PIN, or set your own in **Project Settings → Script properties → `ADMIN_PIN`**.
4. Edit the **Config** tab: raffle name, prizes, price, total slots, hold minutes, and your
   payment instructions. (Change `totalSlots` *before* the raffle opens; re-run `setup`
   on a fresh sheet if you change it later.)
5. **Deploy → New deployment → Web app.** Execute as: **Me**. Who has access: **Anyone**.
   Deploy and copy the `…/exec` URL.

   > After any later edit to `Code.gs`, use **Deploy → Manage deployments → Edit → New version**,
   > otherwise the live URL keeps running the old code.

### 2. Front end — pick one free host
Put the contents of `web/` online and set `API_URL` in `web/config.js` to the URL from step 1.5 first.

| Host | How | Notes |
|---|---|---|
| **Cloudflare Pages** | Pages → Create project → Direct Upload → drag the `web` folder | Free, fast, no repo needed. Easiest. |
| **Netlify Drop** | drag the `web` folder onto app.netlify.com/drop | Free, 30 seconds. |
| **GitHub Pages** | Put `web/` contents in a repo (root or `/docs`), Settings → Pages → deploy from branch | Free; repo must be public on the free plan. |

Customer link: `https://your-site/` · Admin link: `https://your-site/admin.html` (PIN-protected; not linked anywhere).

Payment QR: the payment step shows `web/gcash-qr.jpg` above the text from the `paymentInstructions` Config cell.
Replace that image with your own QR (or delete it to hide the QR) and redeploy.

### 3. Run a raffle
1. Share the customer link in your Facebook group/page.
2. Open the admin page. **Needs review** lists each reservation with the proof link
   (opens in your Google Drive). **Approve** secures the slots; **Copy confirmation**
   gives you the "Payment confirmed 🎟️" message to paste into Messenger.
3. Unpaid holds expire by themselves after `holdMinutes` (no timer to run).
4. When sold out or on draw day: **Close & freeze final entries** (locks the paid list into
   a `FinalEntries` tab and rejects unpaid holds), then **Draw next prize** on the livestream.
   A slot that wins is excluded from later prizes. Winners are recorded in the `Draws` tab
   and shown on the public board.
5. Next raffle: copy the Sheet (File → Make a copy), re-run `setup` in the copy, deploy it as
   its own web app, and use a new `API_URL`. Keep each raffle's sheet as its record.

## What the system protects against
- **Double booking:** every write takes a script lock and rechecks the slot, so two people
  grabbing #27 at once get one winner and one "just taken" message.
- **Hoarding:** unpaid holds expire; one mobile number can have at most 3 open reservations.
- **Clean sheet:** expired, rejected and released orders free their slots and their row is deleted from the
  `Orders` tab (the payment screenshot stays in Drive). An expired hold can't be approved late; the customer picks again.
- **Privacy:** the public board shows only "Maria S."; mobile numbers and screenshots are admin-only,
  and screenshots are stored privately in your Drive (not public links).
- **Sheet injection:** name/FB/mobile columns are plain-text formatted so typed text can't run as a formula.

## Limits worth knowing
- Payment checking is still **manual by design** — you compare the screenshot with your wallet.
- The admin PIN is a simple shared secret, fine for one organiser; don't reuse a real password.
  The PIN is sent in the request body (not the URL).
- Apps Script adds about 1–2 seconds per request and is limited to roughly 30 concurrent
  executions; a 100-slot raffle is nowhere near that.
- The draw uses `Math.random()` on the frozen list, which is fine for a livestreamed club
  raffle, but it is not audited randomness. Showing the frozen list on stream first is what
  makes it credible.
- The board polls every 20 s; a customer sees "just taken" at submit time, never a double booking.

## Tests
`tests/e2e.js` drives the real pages in Chromium (demo mode): reserve → race for the same slot →
upload proof → approve → public board → reject → freeze → three draws with no repeat winner.
`Code.gs` itself can only run inside Google, so the same rules are mirrored in the demo
backend in `api.js` and tested there; do one live dry run (reserve, upload, approve) after deploying.

```bash
python3 -m http.server 8765 --directory web &
npm i playwright && node tests/e2e.js     # set CHROME=/path/to/chrome if needed
```
