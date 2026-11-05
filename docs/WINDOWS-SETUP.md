# Restaurant POS — Windows setup and handover guide

This guide sets up the POS on **two Windows PCs** in one restaurant:

| PC | What it does |
|----|--------------|
| **Reception PC** | Runs the POS server and the database. Staff use it with the **Reception** login. |
| **Kitchen PC** | Only opens a web browser to the reception PC and uses the **Kitchen** login. Nothing is installed on it. |

Everything stays inside the restaurant. Nothing is sent to the internet, and **the POS must never be
reachable from the internet** (no router "port forwarding").

> **Status of testing:** the whole workflow was tested automatically in browsers on one machine,
> including the kitchen screen connecting over the network address. It has **not yet been tested on two
> physical PCs or with a physical printer** — do the checks in [section 10](#10-first-day-checks-on-the-real-pcs)
> before the first service.

---

## 1. Install on the Reception PC

1. Install **Node.js 22 LTS** (22.12 or newer) from <https://nodejs.org> → *Windows Installer (.msi)*.
   Keep the default options. Open a new **Command Prompt** and check: `node -v` shows `v22.…`.
2. Put the POS folder somewhere permanent, e.g. `C:\RestaurantPOS\pos-software`
   (download it from GitHub, or `git clone` it).
3. In a Command Prompt in that folder:

   ```bat
   cd C:\RestaurantPOS\pos-software
   npm run setup
   npm run build
   ```

   `setup` installs everything and creates the database with the Two Hearts Cafe menu and cafe details. `build` prepares the screens.

4. Create the **Superadmin** login (the owner's login — choose a strong password, at least 10 characters;
   nothing is shown while you type it):

   ```bat
   npm run auth:setup
   ```

There are no default passwords anywhere.

## 2. Give the Reception PC a fixed address

The kitchen PC finds the reception PC by its network address (for example `192.168.1.20`). If that
address changes, the kitchen screen stops working, so make it fixed. **Recommended: a DHCP reservation
in the router** (the router always gives this PC the same address):

1. On the reception PC run `ipconfig /all` and note, for the Wi-Fi or Ethernet adapter that is connected,
   the **Physical Address** (e.g. `3C-52-82-AA-BB-CC`) and the **IPv4 Address** (e.g. `192.168.1.20`).
2. Open the router's admin page (usually `http://192.168.1.1` or `http://192.168.0.1`; the address and
   password are often on a sticker on the router).
3. Find *DHCP*, *LAN* or *Address reservation* / *Static lease*, and reserve the IPv4 address for that
   physical (MAC) address. Save, then restart the reception PC.
4. Run `ipconfig` again and confirm the address stayed the same.

If the router has no reservation feature, set a static IP in Windows instead (*Settings → Network →
your adapter → IP assignment → Edit → Manual*), choosing an address **outside** the router's DHCP range.

Prefer an **Ethernet cable** for the reception PC if possible; Wi-Fi drops are the most common cause of
"Reconnecting" on the kitchen screen.

## 3. Windows network settings and firewall (Reception PC)

1. Mark the restaurant network as **Private** (not Public): *Settings → Network & internet → Wi-Fi (or
   Ethernet) → your network → Network profile type: Private*. Never use the guest Wi-Fi for the POS.
2. Allow the POS port **only from the local network**. Open **PowerShell as Administrator** and run
   (change `3001` if you changed `PORT`):

   ```powershell
   New-NetFirewallRule -DisplayName "Restaurant POS (TCP 3001, local network only)" `
     -Direction Inbound -Protocol TCP -LocalPort 3001 -Action Allow `
     -Profile Private -RemoteAddress LocalSubnet
   ```

   - `-Profile Private` → only when connected to a network marked Private.
   - `-RemoteAddress LocalSubnet` → only computers on the same local network may connect.
3. The first time the server starts, Windows may show *"Windows Defender Firewall has blocked some
   features of Node.js"*. Tick **only "Private networks"** and click *Allow*. If you ever allowed it on
   *Public* networks, remove that: *Windows Security → Firewall → Allow an app → Node.js → untick Public*.
4. **Do not** set up port forwarding on the router.

To check the rule: `Get-NetFirewallRule -DisplayName "Restaurant POS*" | Format-List DisplayName,Enabled,Profile`.

## 4. Start, stop and start automatically

**Start:** double-click **`start-pos.cmd`** in the POS folder (or run `npm start` in a Command Prompt
there). A window opens and shows:

```
 Restaurant POS is running (HTTP). Keep this window open.
 Reception (this PC):  http://localhost:3001
 Kitchen PC:           http://192.168.1.20:3001/kitchen
 Database: C:\RestaurantPOS\pos-software\server\data\pos.db
 Backups:  C:\Users\<you>\RestaurantPOS\backups (every 1 h when data changed)
```

**Keep that window open** while the restaurant is working (you can minimise it).

**Stop:** click into that window and press **Ctrl+C**, then **Y**. The server saves a final backup and
says *Stopped.* (Closing the window with the X also stops it; the database stays safe, but no final
backup is made.)

**Start automatically when the reception PC is switched on:** press `Win+R`, type `shell:startup`,
press Enter, and put a **shortcut** to `start-pos.cmd` in that folder.

**After updating the POS** (new version from GitHub): stop the server, then `npm install`,
`npm run build`, and start again. Database changes are applied automatically at start, **after** an
automatic backup.

## 5. Logins

Open `http://localhost:3001` on the reception PC and sign in as **Superadmin**.

- **Settings (⚙) → Logins → Set up** the **Reception** and **Kitchen** logins (username and a password or
  PIN of at least 6 characters). You confirm with your own Superadmin password.
- To change any login later: *Settings → Logins → Change*. That login is signed out on every screen at once.
- Then sign out and let staff sign in with the **Reception** login for daily work.

| Login | Can use |
|-------|---------|
| Superadmin | Everything: settings, taxes, menu prices, discounts, refunds, all sales days, logins, backups |
| Reception | New orders, orders list, checkout, cash and UPI payments, receipts, today's sales |
| Kitchen | The kitchen screen only (no prices, no payments) |

**Forgot the Superadmin password?** On the reception PC, in the POS folder:

```bat
npm run auth:setup -- --reset
```

It makes a backup first, then sets a new Superadmin username and password and signs the old one out
everywhere. Only someone who can use the reception PC can do this, so **lock the reception PC's Windows
account** with a password.

## 6. Kitchen PC

1. Connect it to the same restaurant network (staff Wi-Fi or cable — not guest Wi-Fi).
2. Open **Chrome** or **Edge** and go to the *Kitchen PC* address shown in the server window, for example
   `http://192.168.1.20:3001/kitchen`. **Do not type `localhost`** on the kitchen PC — that means the
   kitchen PC itself.
3. Sign in with the **Kitchen** login. Bookmark the page. For a clean full-screen display press **F11**.
4. The header shows **Live** when updates arrive instantly. **Live (polling)** also works — it means
   WebSockets are blocked somewhere on the network and the screen uses a slightly slower fallback.
   **Reconnecting** means it lost the connection; it retries by itself and catches up when the network
   is back.

## 7. Backups

The server backs up the database **automatically**:

- when it starts (before applying any update), every hour while something changed, before the
  Superadmin changes settings/logins/menu prices or records a refund, and when it is stopped with Ctrl+C;
- using SQLite's online backup (safe while the POS is in use). **Never copy `pos.db` itself while the
  server is running** — the copy can be incomplete;
- each backup is checked after it is written; only checked backups get a final name;
- into `C:\Users\<you>\RestaurantPOS\backups` (change with `BACKUP_DIR` in `server\.env`), as files like
  `pos-20261022-143000-scheduled.db`;
- **kept:** every backup from the last 48 hours, then the newest of each day for 60 days; the newest 10
  are never deleted.

The Superadmin can see the status (last backup, errors such as a full disk) and press **Back up now** in
*Settings → Backups*. From a Command Prompt in the POS folder:

```bat
npm run db:backup      &REM back up now (OK while the server is running)
npm run db:backups     &REM list backups
```

or double-click `backup-now.cmd`.

### Keep a copy away from the reception PC (important)

Backups on the same PC are lost if that PC is stolen, damaged, or its disk fails. **At least once a
week** (daily is better), copy the backup folder to a USB drive and keep the drive somewhere else
(e.g. the owner takes it home):

```bat
robocopy "%USERPROFILE%\RestaurantPOS\backups" "E:\POS-backups" /E /XO
```

(`E:` is the USB drive.) The backups contain sales records and login data (hashed passwords), so use an
**encrypted** USB drive (on Windows Pro: right-click the drive → *Turn on BitLocker*) and do not upload
them to public file-sharing services.

## 8. Restore a backup

Only needed after a disaster or a serious mistake.

1. **Stop the server** (Ctrl+C in its window).
2. In a Command Prompt in the POS folder, check the backup you want:

   ```bat
   npm run db:backups
   npm run db:restore -- --check "C:\Users\<you>\RestaurantPOS\backups\pos-20261022-143000-scheduled.db"
   ```

3. Restore it (use the full path, or `latest` for the newest backup):

   ```bat
   npm run db:restore -- "C:\Users\<you>\RestaurantPOS\backups\pos-20261022-143000-scheduled.db"
   ```

   The command refuses to run while the server is running, checks the backup, **saves the current
   database first** as a `…-pre-restore.db` backup (so a restore can itself be undone), and then replaces it.
4. Start the server again and check the Orders and Sales screens.

Everything after the backup's time (orders, payments) is not in the restored database — write those
down from paper receipts if needed.

## 9. HTTPS (encrypting the connection) — optional, recommended

By default the POS uses plain **HTTP**. Anyone who can capture traffic on the same network could read
**passwords, session cookies and sales data** and could take over a signed-in session. Keeping the POS on
a private, password-protected staff network reduces this risk but does not remove it. HTTPS encrypts
the connection. Set it up **after** the reception PC has its fixed address (section 2):

1. On the reception PC, in the POS folder (use the reception PC's fixed address):

   ```bat
   npm run tls:setup -- 192.168.1.20
   ```

   This creates, in `C:\Users\<you>\RestaurantPOS\tls`: `restaurant-pos-ca.crt` (to install on both PCs),
   `server.crt` and `server.key` (used by the server; keep `server.key` private). The key that created
   them is thrown away, so the certificate cannot be used to impersonate any other website.
2. Add the two lines it prints (`TLS_CERT_FILE=…` and `TLS_KEY_FILE=…`) to `server\.env`.
3. Install `restaurant-pos-ca.crt` on **both PCs** (copy it to the kitchen PC with a USB stick). Either
   double-click it → *Install Certificate* → *Local Machine* → *Place all certificates in the following
   store* → **Trusted Root Certification Authorities** → Finish; or in a Command Prompt **as
   Administrator**:

   ```bat
   certutil -addstore -f Root restaurant-pos-ca.crt
   ```

   Chrome and Edge use the Windows store (restart the browser). Firefox has its own store
   (*Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import*).
4. Restart the POS server. It now shows `https://…` addresses. Use `https://192.168.1.20:3001/kitchen`
   on the kitchen PC and update the bookmark.

If the reception PC's address ever changes, run step 1 again and reinstall the new
`restaurant-pos-ca.crt` on both PCs (you can remove the old one: run `certmgr.msc` → *Trusted Root
Certification Authorities* → *Certificates* → "Restaurant POS Local CA" → Delete).

HTTPS was tested in a browser that trusts the certificate (TLS 1.3, secure cookie, secure live updates);
installing it on real Windows PCs has not been tested yet.

## 10. First-day checks on the real PCs

Do these once, before the first service, with both PCs in their real places:

1. Kitchen PC opens the kitchen address, signs in, header shows **Live** (or **Live (polling)**).
2. Reception: create a dine-in order with a table number and a note. It appears on the kitchen screen
   within a second, **without prices**.
3. Kitchen: *Start preparing* → *Mark ready*. Reception's Orders screen updates, and a "ready" message appears.
4. Reception: *Mark served*, *Checkout*, take a cash payment, *Print receipt* (see section 11).
5. Unplug the kitchen PC's network (or switch off its Wi-Fi) for 30 seconds, create another order at
   reception, reconnect: the kitchen catches up by itself, with no duplicate tickets.
6. Stop and start the server: both screens reconnect by themselves and all orders are still there.
7. *Settings → Backups* shows a recent backup.

## 11. Printing receipts

Receipts print through the browser's normal print dialog (no special driver integration). In
*Checkout → Print receipt* choose **80 mm roll** (receipt printers) or **A4** (normal printers).

The first time, in the print dialog:

- choose the receipt printer and, for 80 mm printers, its **80 mm paper size** in *More settings*
  if offered;
- **Margins: None** (or *Default*), **Scale: 100 / Default**;
- untick **Headers and footers** (date and web address at the top/bottom of the page).

Chrome and Edge remember these settings. Tip: to print without the dialog on the reception PC, start
Chrome with `--kiosk-printing` (prints straight to the default printer).

The receipt layout was checked as PDF (80 mm × receipt length, and A4, one page, no clipping, no browser
header/footer space). **Printing on a physical printer has not been tested yet** — print a test receipt
on the real printer and check that nothing is cut off on the right edge and the totals are readable.
80 mm printers with a Windows driver (most USB receipt printers) work this way; the app does not talk
to printers directly.

## 12. Payments: what the POS does and does not do

- **Cash:** the cashier enters the amount received; the POS shows the change and records the payment.
- **UPI:** the POS **does not check UPI payments**. The cashier must see the money arrive in the
  merchant app or bank before ticking *"I have verified…"*. A QR code, a payment request or the
  customer's phone screen is **not** proof of payment.
- **Paytm card/UPI terminal: not integrated.** The POS cannot see what the terminal did. Do not record a
  terminal payment as anything other than what you verified yourself. A real integration needs the
  terminal model, Paytm's approved integration method and credentials.
- Refunds (full refunds only) and discounts are Superadmin-only.

## 13. Troubleshooting

| Problem | What to do |
|---------|------------|
| Kitchen PC: page doesn't load | Is the server window open on the reception PC? Same network (not guest Wi-Fi)? Using the address from the server window, not `localhost`? Firewall rule present (section 3) and network marked *Private*? From the kitchen PC run `Test-NetConnection 192.168.1.20 -Port 3001` in PowerShell — `TcpTestSucceeded : True` means the network and firewall are fine. |
| Server window: *Port 3001 is already in use* | The server is already running (check the taskbar for another window), or another program uses the port. Change `PORT` in `server\.env` (and the firewall rule). |
| Server window: *WARNING: the app screens are not built yet* | Stop it, run `npm run build`, start again. |
| Header shows **Reconnecting** | Network or server down. It recovers by itself; the screen keeps the last known orders and refreshes every 10 s meanwhile. |
| Header shows **Live (polling)** | Works normally, slightly slower. Something (router, antivirus, proxy) blocks WebSockets. |
| *"Your session ended. Please sign in again."* | Normal after 12 hours without activity, after 7 days, or after the login's password was changed. |
| *"Too many sign-in attempts"* | Wait 15 minutes. Restarting the server also clears it. |
| Settings → Backups shows **The last backup failed** | Read the message: usually the disk is full or the backup folder is not writable. Free up space, then press *Back up now*. |
| HTTPS: browser says *Not secure* / certificate error | `restaurant-pos-ca.crt` not installed in *Trusted Root Certification Authorities* on that PC, or the address in the browser is not the one used in `tls:setup`. |
| Something else | The server window shows what happened (it never prints passwords). Take a photo of it. |

## 14. Command summary (in the POS folder on the reception PC)

```bat
start-pos.cmd                       &REM start the server (or: npm start)
REM stop: Ctrl+C in the server window, then Y
npm run auth:setup                  &REM create the first Superadmin
npm run auth:setup -- --reset       &REM reset a forgotten Superadmin password
npm run db:backup                   &REM back up now
npm run db:backups                  &REM list backups
npm run db:restore -- --check FILE  &REM check a backup
npm run db:restore -- FILE          &REM restore (server stopped; current DB is saved first)
npm run tls:setup -- 192.168.1.20   &REM create HTTPS certificates
npm install && npm run build        &REM after updating the POS
```
