# Restaurant POS

A simple, reliable point-of-sale system for **one small restaurant**, running on two computers on the same Wi-Fi:

- **Reception computer** runs the server + database, and staff create orders in the browser.
- **Kitchen computer** opens the same app in a browser over the local network (kitchen screen arrives on Day 2).

No cloud, no subscription: everything is stored in a single SQLite file on the reception computer.

> **Status: Day 5** — order entry, live kitchen display, billing, cash and manually verified UPI
> payments, refunds, receipts, sales summary, three logins, automatic checked backups with restore,
> and optional HTTPS are done.
> **Setting up the restaurant's two Windows PCs: see [docs/WINDOWS-SETUP.md](docs/WINDOWS-SETUP.md).**
> Not built: card/UPI terminal (Paytm) integration, inventory, accounting/GST filing.
> Not yet verified: two physical PCs and a physical receipt printer (see "Verification status").

---

## Tech stack

| Part      | Choice                                   | Why |
|-----------|------------------------------------------|-----|
| Frontend  | React + TypeScript + Vite + Tailwind CSS | Fast dev server, typed code, utility CSS without a design system to maintain |
| Backend   | Node.js + Express 5                      | Small, well known; Express 5 forwards thrown errors to the error handler automatically |
| Database  | SQLite via **better-sqlite3**            | A single file, zero setup, very fast for one restaurant |
| ORM       | **Drizzle ORM** + drizzle-kit            | Type-safe queries, plain SQL migration files you can read |
| Validation| Zod                                      | Every request body is validated on the server |
| Tests     | Vitest + Supertest                       | API tests run against a fresh in-memory database |

## Project layout

```
pos-software/
├── package.json          # npm workspaces + top-level scripts
├── server/
│   ├── .env.example      # configuration (copy to .env)
│   ├── drizzle/          # SQL migrations (generated, committed to git)
│   ├── src/
│   │   ├── index.ts      # starts the HTTP server and attaches Socket.IO to it
│   │   ├── realtime.ts   # Socket.IO: authenticated, staff/kitchen rooms, forwards order events
│   │   ├── auth/setup.ts # `npm run auth:setup` — first Superadmin / password reset
│   │   ├── backup/       # automatic checked backups, `db:backup` / `db:restore` commands
│   │   ├── tls/          # `npm run tls:setup` — local HTTPS certificates
│   │   ├── payments/provider.ts  # interface for a future payment terminal (none registered)
│   │   ├── app.ts        # Express app: routes, CORS, error handling
│   │   ├── config.ts     # reads + validates environment variables
│   │   ├── events.ts     # in-process event bus ('order.created')
│   │   ├── validation.ts # Zod schemas for request bodies
│   │   ├── db/           # schema, connection, migrate, seed & menu:load scripts, cafe menu
│   │   ├── lib/          # money, billing maths, order numbers, payment status, password hashing,
│   │   │                 #   sessions/role checks (auth.ts), login throttling, AppError
│   │   ├── routes/       # thin HTTP layer: parse input → call service → send JSON
│   │   └── services/     # business logic (menu, orders, billing & payments, auth)
│   └── tests/            # API + unit tests
└── client/
    ├── .env.example
    └── src/
        ├── App.tsx       # screens + URL routing (/, /orders, /kitchen), order submission
        ├── api/          # fetch wrapper + API types
        ├── state/
        │   ├── cart.ts          # current-order reducer (pure functions, unit-tested)
        │   ├── draftStorage.ts  # keeps the unsent order across refreshes
        │   ├── orders.ts        # merging snapshot + live events, kitchen lanes (unit-tested)
        │   ├── Auth.tsx         # who is signed in (from the server), login/logout, expiry
        │   ├── permissions.ts   # screens per role (UI only; the server enforces)
        │   └── LiveOrders.tsx   # one Socket.IO connection + REST snapshot, shared by screens
        ├── index.css     # design tokens (colours, radii, shadows, motion) + base styles
        ├── components/   # Header, CategorySidebar, MenuGrid, OrderPanel, OrdersView, KitchenView,
        │                 #   CheckoutView, Receipt(+Printer), SalesView, SettingsView, LoginView
        │   └── ui/       # reusable primitives: Button, IconButton, SegmentedControl,
        │                 #   StatusBadge, AnimatedValue, Toast
        └── lib/          # money formatting, request-id generation, cx() class helper
```

## Key design decisions

- **Money is integer paise** (`₹240.50` → `24050`). Floats like `0.1 + 0.2` are never used for money; we only divide by 100 when displaying.
- **The server decides prices.** The browser sends only `menuItemId` + `quantity`. The server loads names and prices from the database, so a modified request cannot change the bill.
- **Order items store snapshots** of the item name and unit price. Changing the menu later never changes old orders.
- **Human-readable order numbers**: `YYMMDD-NNN`, e.g. `261021-007` = 7th order on 21 Oct 2026. The counter restarts daily and uses the reception computer's local date. A unique constraint guarantees no duplicates.
- **Duplicate submission protection** (two layers):
  1. The Send button is locked while a request is in flight (a double-tap is ignored).
  2. Each draft order has a random `clientRequestId`. If the same request reaches the server twice (double click, network retry), the server returns the already-saved order instead of creating another one (HTTP 200 with `duplicate: true`). The id is only replaced after a successful save, so pressing *Send* again after a network error is always safe.
- **Validation happens on the server** (Zod + DB `CHECK`/`UNIQUE`/foreign-key constraints). The frontend checks too, but only for convenience.
- **Errors**: every API error has the shape `{ "error": { "code", "message", "details?" } }`. Unexpected errors return a generic 500 message; internal details are logged on the server only.
- **Real-time updates** use Socket.IO on the same server and port as the API (see below). The order service emits events on an in-process bus only after a database transaction has committed; `realtime.ts` forwards them to every screen.
- **One origin**: in development Vite proxies `/api` to Express; in production Express serves the built React app. The browser never needs CORS, and has no direct database access — only the REST API.

## Billing, payments and receipts (Day 3)

### Workflow

1. **Orders → Checkout** on any order opens `/checkout/<id>`. The server creates the bill from the
   stored order lines and the current tax settings. The cashier can add a discount (percent or
   amount, with a required reason).
2. **Cash**: type the amount received (or tap *Exact* / a round note). Change due is shown live;
   an amount below the total cannot be recorded. **UPI**: the cashier checks the money arrived in the
   merchant app or bank, ticks *“I have verified …”*, optionally types the UPI reference (UTR) and
   records it. A failed UPI attempt can be recorded with a reason.
3. The bill closes, the order shows **Paid** everywhere instantly (Socket.IO), and **Print receipt**
   opens the browser's print dialog (80 mm roll or A4). Unpaid bills can be printed too; they are
   clearly marked **NOT PAID**.
4. **Sales** shows the day's figures; **Settings** (Superadmin) holds receipt details, tax rates and logins.

Payment status (**Unpaid / Paid / Payment failed / Check payment / Refunded**) is shown next to, and
completely separate from, the kitchen status. Paying an order does not change its kitchen status and
vice versa.

### Bill maths (all integer paise; rates in basis points, 1% = 100 bps)

```
subtotal          sum of order lines (prices snapshotted when the order was placed)
− discount        PERCENT of subtotal or a fixed AMOUNT; must be less than the subtotal
= taxable
+ each tax line   taxable × rate, rounded per line
+ round off       only if "round to nearest rupee" is on
= total
```

**Rounding rule:** every fraction of a paisa is rounded **half up** (0.5 → 1), separately for the
discount and for each tax line. The optional rupee round-off is also half up (₹661.50 → ₹662).
Menu prices are treated as **tax-exclusive**. The app ships with **no tax rates**: the operator enters
the rates that apply to them in Settings (Superadmin only). The software does not decide rates and does not make bills
tax-compliant (there are, for example, no sequential invoice numbers yet).

Once a bill is **paid** it is frozen: later menu price, tax or settings changes never alter it or its
receipt.

### Data model (migration `0001_billing_payments`)

The migration only **adds** tables; existing orders and menu data are untouched (verified by
upgrading a copy of a live Day 2 database, and on server start).

| Table | Purpose |
|-------|---------|
| `restaurant_settings` | single row: name, address, phone, tax ID, receipt footer, round-to-rupee |
| `tax_rates` | name + `rate_bps` |
| `bills` | one per order: subtotal, discount (type/value/reason/paise), tax lines (JSON snapshot), round off, total, status `OPEN/PAID/REFUNDED`. CHECK constraints enforce that the parts add up |
| `payments` | one row **per attempt** (never deleted): method `CASH/UPI_MANUAL/TERMINAL`, status `PENDING/SUCCEEDED/FAILED/UNKNOWN/REFUNDED`, amount, cash tendered/change, unique `idempotency_key`, provider + provider reference, failure reason, timestamps, refund info |

Database-level guards: a partial unique index allows **only one SUCCEEDED payment per order**, another
allows **only one PENDING/UNKNOWN attempt per order**, and cash rows must satisfy
`tendered ≥ amount AND change = tendered − amount`.

### Payment integrity

- The amount due is always read from the stored bill; the client only sends the total it *saw*
  (`expectedTotalPaise`) so the server can refuse with `BILL_CHANGED` if the bill changed meanwhile.
- Every attempt carries a client-generated `idempotencyKey`. Repeating a request (double tap, network
  retry) returns the original attempt (HTTP 200, `duplicate: true`) — never a second payment.
- Payment insert + closing the bill + bumping the order happen in **one SQLite transaction**; the
  `order.updated` event is broadcast only after it commits. A failure anywhere rolls everything back.
- A second payment for a paid order is refused (`ALREADY_PAID`), by the service and by the unique index.
- **Uncertain outcomes:** a future terminal payment is written as `PENDING` *before* contacting the
  device, then becomes `SUCCEEDED`, `FAILED` or **`UNKNOWN`** (timeout, error, ambiguous reply).
  `UNKNOWN` is never retried automatically and blocks new attempts for that order until someone checks
  the terminal/bank and resolves it (Superadmin: *Money received* / *It failed*, with a note).
- **Refunds** (Superadmin): full refunds of cash/manual-UPI payments only, recorded after the money has been
  returned (explicit confirmation + reason). Partial refunds are not supported.

### Payment terminal (Paytm) — not integrated

`server/src/payments/provider.ts` defines the `PaymentProvider` interface and the two-phase flow above
is implemented and tested **with a test double only**. No provider is registered, no credentials or
endpoints exist, and choosing *Terminal* returns `PROVIDER_NOT_CONFIGURED`. A real integration needs the
supported device model, the approved integration method and credentials; it then only has to implement
`collect()` and be passed to `createApp({ paymentProviders: [...] })`.

### Receipts

Printed with the browser's standard print dialog and a print-only stylesheet (`index.css`,
“Receipt print styles”); only the receipt is printed. **80 mm roll**: the page is 80 mm wide and as
long as the receipt; **A4**: centred on an A4 page. Works with any printer that has a normal system
driver. There is no direct thermal-printer (ESC/POS) integration. The receipt data is always fetched
from the server (`GET /api/orders/:id/receipt`), never assembled from screen state.

### Daily sales summary (`/sales`)

- Day = midnight to midnight in the **reception computer's local time**.
- **Gross sales** = payments **completed** that day (cash basis), including ones later refunded.
- **Refunds** are subtracted on the day the refund was **recorded**, even for an older sale, so a past
  day's figures never change. **Net** = gross − refunds.
- Cash / UPI totals always add up to gross sales. FAILED, PENDING and UNKNOWN attempts are never revenue.
- **Unpaid** = orders created that day without a successful payment (bill total, or an estimate with
  current taxes if no bill exists yet). The table lists every payment attempt of the day.

## Order workflow and real-time updates

```
Sent to kitchen ──► Preparing ──► Ready ──► Served
   (NEW)          (PREPARING)    (READY)   (COMPLETED)
   reception       kitchen        kitchen   reception
```

- "Served" is stored as the existing `COMPLETED` status, so **no database migration was needed**.
  `CANCELLED` exists in the schema but has no workflow yet. Payment will be a separate field (Day 3),
  never mixed into this status.
- The server validates every step: only the arrows above are allowed. Anything else returns
  `409 INVALID_TRANSITION` and changes nothing. Repeating a request that already happened
  (e.g. two taps on "Start preparing") returns `200` with `changed: false` and broadcasts nothing.
- The check and the update run in one SQLite transaction with a conditional `UPDATE … WHERE status = <old>`,
  so two screens pressing at the same time can never skip or repeat a step.

### Socket.IO events

Socket.IO runs on the same port as the API (`/socket.io`). The server only **sends**; it ignores
anything a browser sends, so sockets cannot change data — every change goes through the REST API.

| Event           | Payload            | When |
|-----------------|--------------------|------|
| `order.created` | `{ order: Order }` | a new order was saved (not for duplicate submissions) |
| `order.updated` | `{ order: Order }` | an order's status really changed (not for repeated requests) |

`Order` is the same object the REST API returns, re-read from the database after the change.
Connection state (Live / Connecting / Reconnecting) is tracked in the browser and shown in the header.

How screens stay correct:

1. On load **and after every reconnect**, the screen fetches a REST snapshot
   (`GET /api/orders?limit=100` and `GET /api/orders?status=NEW,PREPARING,READY&limit=200`).
   Socket.IO does not replay missed events, so this is how a screen catches up after Wi-Fi drops
   or the server restarts.
2. Live events are merged into the same list by order id; the version with the newest `updatedAt`
   wins. An order that appears in both the snapshot and an event is therefore never shown twice.
3. While disconnected, a warning banner appears, the last known orders stay visible, and the snapshot
   is re-fetched every 10 seconds. The socket reconnects automatically.

Browser connections from other websites are refused (the `Origin` must match the server, or be listed in
`CORS_ORIGINS`), so a random web page open on a staff computer cannot read the order stream.

## Using two computers (reception + kitchen)

1. On the **reception computer**: `npm run build`, then `npm start`. The server prints, for example:
   ```
   On your network:  http://192.168.1.20:3001   (kitchen: http://192.168.1.20:3001/kitchen)
   ```
2. Reception opens `http://localhost:3001` (or the network address).
3. The **kitchen computer** opens `http://192.168.1.20:3001/kitchen` in Chrome/Edge. Nothing is
   installed on the kitchen computer. Do **not** use `localhost` there — that would mean the kitchen
   computer itself.
4. If the kitchen cannot connect: allow Node.js through the reception computer's firewall (private
   networks only), make sure both are on the same Wi-Fi, and give the reception computer a fixed IP
   (DHCP reservation in the router) so the kitchen bookmark keeps working.

The browser always talks to the computer that served the page, so no address needs configuring.
Only if you host the frontend somewhere else, set `VITE_API_URL` in `client/.env` and add the
frontend's origin to `CORS_ORIGINS` in `server/.env`.

In development (`npm run dev`), open `http://<reception-ip>:5173/kitchen`; Vite forwards both `/api`
and `/socket.io` to the server.

## UI design system

The interface follows a restrained, macOS-inspired style. Everything visual is defined once in
`client/src/index.css` (`@theme` block) and used through Tailwind classes such as `bg-canvas`,
`text-ink-2`, `bg-accent`, `shadow-card`, `rounded-card`. Avoid raw colours in components.

| Token group | Purpose |
|-------------|---------|
| `canvas`, `surface`, `subtle`, `fill`, `line` | Warm neutral background, white cards/panels, control tracks, dividers |
| `ink`, `ink-2`, `ink-3` | Primary, secondary and tertiary text (all ≥ 4.5:1 contrast on white) |
| `accent`, `success`, `warning`, `danger` (+ `-tint`) | Actions/selection, and order-status colours |
| `shadow-card`, `shadow-control`, `shadow-raised`, `shadow-toast` | The only depth levels used |
| `animate-enter`, `animate-tick`, `animate-toast-in/out` | Short one-shot animations (≤ 260 ms) |

Rules of thumb:

- Icons come from `lucide-react` only. Icon-only buttons must have an `aria-label`.
- Money and quantities use `tabular-nums` so digits don't jump.
- Only the header is translucent (`backdrop-blur`); cards are solid.
- Motion is opacity + a few pixels of movement, never loops (except the "Sending…" spinner),
  and is disabled automatically when the OS has *Reduce motion* turned on.
- Keyboard focus always shows a 2 px accent outline (`:focus-visible`).

### Screen sizes

| Width | Layout |
|-------|--------|
| Phones (< 768 px) | Compact header (sign-out always visible) and a bottom tab bar. Menu 2 items per row; a "View order · ₹total" bar opens the order full-screen (closes on send, clear, ⌄ or Esc). Kitchen shows one column at a time (New / Preparing / Ready tabs). Sales payments as a list. Notifications appear under the header. Fields use 16 px text so iPhones don't zoom in. |
| Tablets (768–1023 px) | Screen switcher in the header, order panel beside the menu, kitchen columns scroll sideways. |
| PCs (≥ 1024 px) | Category sidebar, menu grid and order panel side by side. |

Checked in Chromium at 320, 375, 390, 768 and 1440 px (no sideways page scrolling). Not yet tried on a
real phone; a phone uses the same address and logins as the kitchen PC.

## Requirements

- **Node.js 22.12 or newer** (includes npm). Check with `node -v`.
- Windows, macOS or Linux. `better-sqlite3` downloads a prebuilt binary for common platforms.
  If that fails on Windows, install the "Desktop development with C++" workload from Visual Studio Build Tools and retry.

## Deployment, backups and HTTPS (Day 5)

The full, step-by-step guide for the restaurant is **[docs/WINDOWS-SETUP.md](docs/WINDOWS-SETUP.md)**
(installation, fixed IP, firewall rule, logins, kitchen PC, start/stop, backups, restore, HTTPS,
printing, troubleshooting). Summary:

- **Production start:** `npm run build` once, then `npm start` (or double-click `start-pos.cmd`).
  It listens on `0.0.0.0:PORT` (default 3001) and prints the address the kitchen PC must use.
  **Stop:** Ctrl+C in the server window (a final backup is saved).
- **Database:** `server/data/pos.db` (SQLite, WAL mode). Migrations run automatically at start, after a backup.
- **Backups** (`server/src/backup/`): SQLite *online backup API* (consistent while the server runs —
  never copy `pos.db` directly); each backup is integrity-checked before it gets its final name. Made at
  startup (before migrations), every `BACKUP_INTERVAL_HOURS` (default 1) when data changed, before
  Superadmin changes (settings, logins, menu prices, refunds), before `db:reset` / Superadmin reset /
  restore, and at shutdown. Stored in `BACKUP_DIR` (default `~/RestaurantPOS/backups`, outside the app
  folder). Retention: everything from the last 48 h, then one per day for 60 days, never fewer than the
  newest 10. Low disk space and unwritable folders are reported (log + *Settings → Backups*), never
  crash the server, and leave no partial files. Logs contain file names and sizes only.
  - `npm run db:backup` · `npm run db:backups` · `npm run db:restore -- [--check] <file|latest>`
  - Restore refuses while the server runs, checks the backup, saves the current DB as `…-pre-restore.db`
    first, then swaps the file in.
- **HTTPS** (optional): `npm run tls:setup -- <reception IP>` creates a local CA + server certificate
  (the CA private key is never saved, so it cannot sign anything else); set `TLS_CERT_FILE` /
  `TLS_KEY_FILE` and install the CA certificate on both PCs. Cookies become `Secure` automatically and
  live updates use `wss://`.
- **Live connection:** Socket.IO uses WebSockets and falls back to HTTP polling where WebSockets are
  blocked; the header shows *Live* or *Live (polling)*, and the server logs which transport each
  screen uses.

## Logins and permissions (Day 4)

There are **exactly three logins**, one per role. The role belongs to the account: there is no role
picker, and the server decides what each request may do from its session — hiding buttons in the
browser is only a convenience.

### First-time setup

On the reception computer, after `npm install`:

```bash
npm run auth:setup
```

It asks for the Superadmin username and password (at least 10 characters; the password is not shown
while typing). For a scripted setup set `SUPERADMIN_USERNAME` and `SUPERADMIN_PASSWORD` in the
environment instead, and remove them afterwards. Running it again does nothing once a Superadmin
exists. **Forgot the Superadmin password?** On the reception computer: `npm run auth:setup -- --reset`
(signs the Superadmin out everywhere). There are no default or built-in passwords.

Then sign in as Superadmin → **Settings (⚙) → Logins** → *Set up* **Reception** and **Kitchen**
(username + password/PIN of at least 6 characters). The same screen changes any login's username or
password; you must re-enter your own Superadmin password to confirm. Changing a login signs it out on
every screen immediately.

### What each login can do (enforced by the server)

| | Superadmin | Reception | Kitchen |
|---|:-:|:-:|:-:|
| Take and send orders, view menu | ✓ | ✓ | – |
| Orders list (kitchen + payment status) | ✓ | ✓ | – |
| Kitchen display, Start preparing / Mark ready | ✓ | – | ✓ |
| Mark served | ✓ | ✓ | – |
| Checkout, bill, cash & manual-UPI payments, receipts | ✓ | ✓ | – |
| Add / change / remove discounts | ✓ | – | – |
| Refunds, resolving uncertain payments | ✓ | – | – |
| Sales summary | ✓ any day | today only | – |
| Tax & receipt settings, menu edits | ✓ | – | – |
| Manage the three logins | ✓ | – | – |

- The Kitchen login receives orders **without prices or payment information**, over REST
  (`GET /api/kitchen/orders`) and over Socket.IO, and is not told about bill/payment changes.
- Opening a screen the login may not use (e.g. typing `/settings`) shows that login's start screen.
  After sign-in: Superadmin and Reception start on the POS (`/`), Kitchen on `/kitchen`.

### Sessions

- Sign-in sets an **HttpOnly, SameSite=Strict** cookie (`pos_session`) holding a random 256-bit token.
  The database stores only its SHA-256, never the token. Page scripts cannot read it.
- A session ends after `SESSION_IDLE_HOURS` (default 12) without any action, and always after
  `SESSION_MAX_DAYS` (default 7). Sign out ends it immediately on the server. Live screens are
  disconnected on sign-out, on a credential change, and within about a minute of expiry, and then
  show the sign-in page with “Your session ended”.
- Passwords are hashed with **scrypt** (Node's built-in crypto; random salt per password). Plain
  passwords are never stored or logged.
- **Sign-in throttling:** 5 failed attempts for a username lock that username for 15 minutes;
  20 failed attempts from one computer lock that computer for 15 minutes. Errors never say whether
  the username exists. The counters live in memory and reset when the server restarts.

## Installation

```bash
git clone <your-repo-url> pos-software
cd pos-software

# optional: copy config files (defaults work without them)
cp server/.env.example server/.env        # Windows: copy server\.env.example server\.env
cp client/.env.example client/.env

npm run setup       # = npm install + db:migrate + menu:load (Two Hearts Cafe menu)
npm run auth:setup  # create the Superadmin login (see "Logins and permissions")
```

### Configuration (`server/.env`)

| Variable        | Default          | Meaning |
|-----------------|------------------|---------|
| `PORT`          | `3001`           | Port for API (and the built app in production) |
| `HOST`          | `0.0.0.0`        | `0.0.0.0` = reachable from other computers on the Wi-Fi; `127.0.0.1` = this computer only |
| `DATABASE_PATH` | `./data/pos.db`  | SQLite file, relative to `server/` |
| `CORS_ORIGINS`  | *(empty)*        | Extra browser origins allowed to call the API. Normally not needed |
| `SESSION_IDLE_HOURS` | `12`       | Sign out after this many hours without any action |
| `SESSION_MAX_DAYS` | `7`          | Sign out after this many days regardless |
| `COOKIE_SECURE` | `auto`           | `auto` = Secure cookie only when opened over https; `true`/`false` to force |
| `SUPERADMIN_USERNAME` / `SUPERADMIN_PASSWORD` | *(unset)* | Only for a non-interactive `npm run auth:setup`; remove afterwards |
| `BACKUP_DIR` | `~/RestaurantPOS/backups` | Backup folder (keep it outside the app folder) |
| `BACKUP_INTERVAL_HOURS` | `1` | Scheduled backup interval (skipped when nothing changed; `0` = off) |
| `BACKUP_KEEP_RECENT_HOURS` / `BACKUP_KEEP_DAYS` / `BACKUP_MIN_KEEP` | `48` / `60` / `10` | Retention |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | *(empty)* | Enable HTTPS (see `npm run tls:setup`) |
| `RESTAURANT_NAME` | `Two Hearts Cafe` | Receipt name until Settings are saved |

`client/.env`: `VITE_RESTAURANT_NAME` (shown in the header), `API_PROXY_TARGET` (dev only).

## Database

```bash
npm run db:migrate    # apply migrations (also happens automatically when the server starts)
npm run menu:load     # load the Two Hearts Cafe menu + cafe details (backs up first; orders and bills kept)
npm run db:seed       # insert the menu into an empty database (skipped if a menu already exists)
npm run db:reset      # ⚠ DELETE ALL orders, bills, payments and the menu, then re-seed the menu
                      #   (restaurant settings and tax rates are kept)
npm run db:generate   # after editing server/src/db/schema.ts: create a new migration file
```

- The Two Hearts Cafe menu is in `server/src/db/seedData.ts` (prices in paise). Dishes with two sizes are two
  items, e.g. "Veg Chowmein (Half)" and "Veg Chowmein (Full)". Day-to-day price changes are made in the app;
  `npm run menu:load` makes the database menu match the file again. It keeps items marked unavailable,
  removes items no longer on the card (old orders keep their names and prices) and never touches orders,
  bills, payments, logins or tax rates.
- **Back up** with `npm run db:backup` (see Backups above); never copy the live `pos.db` file.
- Changing the schema: edit `schema.ts` → `npm run db:generate` → review the new SQL file in `server/drizzle/` → commit it → restart the server.

## Running

### Development (hot reload)

```bash
npm run dev
```

- Frontend: http://localhost:5173 (Vite, proxies `/api` to the server)
- API: http://localhost:3001/api/health

Run them separately with `npm run dev:server` and `npm run dev:client`.

### Production (on the restaurant's reception computer)

```bash
npm run build     # builds the React app into client/dist
npm start         # serves the API AND the app on port 3001
```

On startup the server prints its network address, e.g. `On your network: http://192.168.1.20:3001`.
Open that URL on the reception computer and (from Day 2) on the kitchen computer.

> If the other computer cannot connect: allow Node.js / port 3001 through the reception computer's firewall
> (Windows will usually ask the first time), and make sure both are on the same Wi-Fi.
> Giving the reception computer a fixed IP (DHCP reservation in your router) keeps the address from changing.

## Tests

```bash
npm test              # server + client tests
npm run typecheck     # TypeScript checks for both
npm run test --workspace server
npm run test --workspace client
```

What is covered:

- **Server backups & HTTPS** (`server/tests/backup.test.ts`, `tls.test.ts`): backup of a live WAL database equals the database exactly (a naive file copy is shown to be incomplete); skipped when unchanged; tiered retention never drops below the minimum; low disk space and unusable folders reported without partial files; no secrets in logs; restore onto a separate copy reproduces every row (orders, items, bills, payments incl. refunds, menu, settings, taxes, users) and saves the replaced DB first; restored DB works with the app; damaged/foreign files refused; backups before Superadmin changes only; backup status Superadmin-only; generated certificates trusted only via the local CA, valid only for the given addresses, no CA key on disk, Secure cookie and `wss` over HTTPS.
- **Server auth & permissions** (`server/tests/auth.test.ts`, `permissions.test.ts`, `realtime.test.ts`): scrypt hashing (salted, verifies only the right password, tamper-proof, no plaintext stored); login success with HttpOnly/SameSite cookie and Secure over HTTPS; identical errors for wrong password and unknown user; role fields in requests rejected/ignored; per-username and per-client lockout; logout invalidates server-side; idle, sliding and absolute expiry; Superadmin-only credential changes with re-authentication, sign-out of the changed login, username clashes; bootstrap create/refuse/reset; cross-site write blocked; a permission matrix calling every protected endpoint anonymously and as each role (401/403/allowed); kitchen and reception status rules; reception discount rule; price-free kitchen data; Socket.IO refuses missing/forged sessions, separates kitchen and staff data, and disconnects on logout, credential change and expiry.
- **Server billing & payments** (`server/tests/billing.test.ts`, `payments.test.ts`): half-up rounding edge cases and a property check that no result has fractional paise; bill totals from stored data with taxes, discounts and round-off; client totals/prices rejected; cash payment, change and exact amount; underpayment rejected with nothing written; idempotent duplicate submissions; already-paid and already-refunded orders refused; bill-changed guard; manual UPI requires explicit verification and stores the reference; failed UPI attempts; transaction rollback when a write fails mid-payment (no row, no event); DB unique index refuses a second success; exactly one event per payment; historical bills/receipts unchanged after price and tax changes; receipt contents; admin-only refunds and settings; terminal path with a test double for success, failure, error, timeout and unknown (blocks retries until resolved); daily summary totals, method split, refunds on the refund day, local-midnight boundaries, reconciliation with the payments table; `db:reset` with payments present.
- **Server real-time & workflow** (`server/tests/realtime.test.ts`, `status.test.ts`): events delivered to multiple connected sockets, exactly one event per mutation (none for duplicates/repeats/invalid moves), client-sent socket events ignored, reconnect + snapshot recovery, foreign-origin rejection, full NEW→PREPARING→READY→COMPLETED walk with persistence, every invalid transition → 409 with no change, strict body validation, multi-status snapshot query.
- **Server** (`server/tests/`): order creation and persistence, totals computed from DB prices, ignoring client-sent prices, price/name snapshots after menu edits, merging duplicate lines, daily sequential order numbers (and reset on a new day), idempotent duplicate submissions, `order.created` event, validation (empty order, zero/negative/fractional/too-large/string quantities, bad order type, table on takeaway, long notes, malformed JSON, unknown items, unavailable items → 409 with nothing saved), listing and filtering orders, 404/400 for bad ids, generic 500 on server failure, database constraints, menu item updates, money and order-number helpers.
- **Client permissions** (`client/src/state/permissions.test.ts`): screens and landing page per role.
- **Client amounts** (`client/src/lib/amounts.test.ts`): rupee and percent strings parsed to integer paise / basis points without floating point, quick cash amounts.
- **Client live orders** (`client/src/state/orders.test.ts`, `draftStorage.test.ts`): no duplicate tickets from snapshot + event, newest-wins merging, out-of-order events ignored, missed changes applied after reconnect, finished orders dropped from the kitchen, kitchen lane grouping/sorting stability, draft validation.
- **Client** (`client/src/state/cart.test.ts`): add/increment/decrement/remove, quantity clamping 1–99, subtotal in paise, empty and unavailable checks, syncing with a refreshed menu, building the API request.

## API reference

| Method | Path                     | Description |
|--------|--------------------------|-------------|
| GET    | `/api/health`            | `{ ok: true }` (public) |
| GET    | `/api/auth/status`       | `{ setupRequired }` (public) |
| POST   | `/api/auth/login`        | `{ username, password }` → sets the session cookie, returns `{ user, expiresAt }` (public) |
| POST   | `/api/auth/logout`       | Ends the session, clears the cookie |
| GET    | `/api/auth/me`           | Current `{ user, expiresAt }` or 401 |
| GET    | `/api/auth/accounts`     | **Superadmin.** The three logins (no password data) |
| POST   | `/api/auth/accounts` | **Superadmin.** Add a login: `{ role, username, password, currentPassword }` (any number per role) |
| PUT    | `/api/auth/accounts/:id` | **Superadmin.** `{ username?, password?, role?, isActive?, currentPassword }` |
| DELETE | `/api/auth/accounts/:id` | **Superadmin.** `{ currentPassword }`; never your own login or the last active Superadmin |
| GET    | `/api/kitchen/orders`    | Kitchen/Superadmin: active orders without prices |
| GET    | `/api/menu`              | Active categories with items (unavailable items included, flagged) |
| PATCH  | `/api/menu/items/:id`    | **Superadmin.** Update `name`, `pricePaise`, `isAvailable` |
| GET    | `/api/orders?status=&limit=` | Recent orders with items, newest first. `status` may be a comma-separated list |
| GET    | `/api/orders/:id`        | One order |
| POST   | `/api/orders`            | Create order → `201` (new) or `200` (duplicate `clientRequestId`) |
| PATCH  | `/api/orders/:id/status` | Body `{ "status": "PREPARING" }` → `{ order, changed }`. Kitchen: PREPARING/READY; Reception: COMPLETED; Superadmin: all |
| GET    | `/api/orders/:id/checkout` | `{ order, bill, payments }` |
| POST   | `/api/orders/:id/bill`   | Create/recalculate the open bill. Body `{ discount?: {type:'NONE'} \| {type:'PERCENT', bps, reason} \| {type:'AMOUNT', paise, reason} }` |
| POST   | `/api/orders/:id/payments` | `CASH`: `{ method, idempotencyKey, expectedTotalPaise, tenderedPaise }`; `UPI_MANUAL`: `{ method, idempotencyKey, expectedTotalPaise, outcome: 'SUCCEEDED'\|'FAILED', manuallyVerified: true, providerReference?, failureReason? }` → `201` new / `200` duplicate |
| GET    | `/api/orders/:id/receipt` | Receipt data (restaurant, order, bill, payment) |
| POST   | `/api/payments/:id/refund` | **Superadmin.** `{ reason, confirmed: true }` — full refund |
| POST   | `/api/payments/:id/resolve` | **Superadmin.** `{ outcome, note, providerReference? }` for PENDING/UNKNOWN attempts |
| GET    | `/api/settings`          | Receipt details + tax rates |
| PUT    | `/api/settings`          | **Superadmin.** Replace receipt details and tax rates |
| GET    | `/api/reports/daily?date=YYYY-MM-DD` | Daily sales summary (Reception: today only) |

Every endpoint except the public ones above needs a signed-in session: without one it returns
`401 UNAUTHENTICATED`, with a login that may not use it `403 FORBIDDEN` (see the permissions table).
Unless noted, order, checkout, payment, receipt, menu and settings reads are Superadmin + Reception.

`POST /api/orders` body:

```json
{
  "clientRequestId": "6f1c…",
  "orderType": "DINE_IN",
  "tableNumber": "5",
  "notes": "Less spicy",
  "items": [{ "menuItemId": 1, "quantity": 2 }]
}
```

Error codes: `VALIDATION_ERROR` (400), `INVALID_JSON` (400), `ITEM_NOT_FOUND` (400), `UNDERPAYMENT` (400), `PROVIDER_NOT_CONFIGURED` (400), `UNAUTHENTICATED` (401), `INVALID_CREDENTIALS` (401), `FORBIDDEN` (403), `REAUTH_FAILED` (403), `BAD_ORIGIN` (403), `USERNAME_TAKEN` (409), `TOO_MANY_ATTEMPTS` (429), `NOT_FOUND` (404), `ITEM_UNAVAILABLE`, `INVALID_TRANSITION`, `CONFLICT`, `BILL_REQUIRED`, `BILL_CHANGED`, `BILL_CLOSED`, `ALREADY_PAID`, `ALREADY_REFUNDED`, `PAYMENT_UNCERTAIN`, `NOT_REFUNDABLE`, `NOT_UNRESOLVED`, `IDEMPOTENCY_KEY_REUSED`, `ORDER_CANCELLED`, `ZERO_TOTAL` (all 409), `INTERNAL_ERROR` (500).

## Verification status (Day 5)

Verified automatically in this development environment (Chromium, one machine):
the complete restaurant workflow with separate Reception and Kitchen sessions (kitchen connecting
through the LAN IP address), price-free kitchen data, live status updates, single payment recording,
receipt print output as PDF (80 mm and A4), sales summary against the database, server restart,
kitchen network interruption and recovery without duplicates, backup + restore on a separate copy,
role restrictions, and HTTPS in a browser that trusts the generated CA (TLS 1.3, `wss`).

**Not yet verified:** two physical Windows PCs on the restaurant network, WebSockets on that network
(in this environment the browser's WebSockets to the LAN address were blocked, so the polling fallback
was exercised there; WebSockets were verified on `localhost` and over HTTPS), installing the HTTPS
certificate on Windows, and printing on a physical printer. See the first-day checks in the guide.

## Security notes

What is in place (Day 4): three logins with scrypt-hashed passwords; server-side sessions in
HttpOnly + SameSite=Strict cookies; a role check on **every** API route and on the Socket.IO connection
(the kitchen gets price-free data in its own room); sign-in throttling; sessions ending on sign-out,
credential change and expiry; a same-origin check on all changes; strict validation of every request;
no internal errors shown to browsers.

**Remaining limitations — read before using this in a real restaurant:**

- **HTTP by default.** Unless HTTPS is set up (`npm run tls:setup`, guide section 9), passwords,
  session cookies and order data travel **unencrypted**; anyone able to capture traffic on the same
  network can read them or take over a session. With HTTPS the connection is encrypted, but the
  network should still be a private, WPA2/WPA3-protected staff network that guests cannot join.
  **Never expose the port to the internet** (no port forwarding).
- Backups live on the reception PC unless the owner copies them elsewhere (guide section 7).
- **Shared logins.** There is one Reception and one Kitchen login, so the system cannot tell which
  cashier took a payment or gave a discount. Keep the Reception password away from people who should
  not take payments; change it when staff leave.
- Anyone with access to the reception computer itself can reset the Superadmin
  (`npm run auth:setup -- --reset`) or read the database file. Lock that computer's user account.
- Sign-in throttling counters reset when the server restarts.
- No audit log of who changed settings, menu prices or logins (payments and refunds are recorded,
  but not by named person).

