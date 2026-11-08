# AWS server: automatic deploys

The live POS runs on one AWS server. Every 2 minutes the server checks GitHub; when the branch has a new
commit it builds it, runs the tests and switches to it. Nothing is stored in GitHub settings, and the
database (`/var/lib/pos`) is never touched.

| What | Where |
|---|---|
| Script | `/usr/local/bin/pos-auto-deploy` (source: `deploy/aws/auto-deploy.sh`) |
| Timer / service | `pos-deploy.timer`, `pos-deploy.service` |
| Releases | `/opt/pos-app/releases/<commit>` (the newest 3 are kept), live one: `/opt/pos-app/current` |
| Log | `/var/log/pos-deploy.log` |
| App service | `pos.service` (settings in `/etc/pos.env`) |

A commit that fails to build, fails a test, or does not start is **not** switched to; the running version
keeps working and the log says why. A failed commit is not retried until a newer commit arrives.

Useful commands on the server:

```
tail -n 30 /var/log/pos-deploy.log          # what the deployer did
sudo -u pos HOME=/opt/pos /usr/local/bin/pos-auto-deploy   # deploy now instead of waiting
ls -l /opt/pos-app/current                   # which release is live
```

Roll back by hand: `sudo ln -sfn /opt/pos-app/releases/<older> /opt/pos-app/current && sudo systemctl restart pos`
(and `echo <full-commit-sha> | sudo tee /opt/pos-app/failed-sha` if the bad commit should not be redeployed).

The changes to the database layout (migrations) run when the app starts, and the app saves a backup first.
Rolling back the code does not undo a migration, so restore a backup from `/var/lib/pos/backups` (or S3) if a
release that changed the database has to be removed.

First-time setup of a new server: `sudo bash deploy/aws/install-auto-deploy.sh`, then run the deploy once,
point `pos.service` at `/opt/pos-app/current/server`, and `systemctl enable --now pos-deploy.timer`.

## Alerts for locked phones (Web Push)

The kitchen / reception phones get a notification even when locked. The server needs its own key pair in
`/etc/pos.env` (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`); without it these alerts are simply off
and the app still works. Keep the private key secret and do not commit it. To make a new pair on the server
(this invalidates every phone's registration - each phone re-registers the next time the app is opened):

```
node -e 'const c=require("crypto");const e=c.createECDH("prime256v1");e.generateKeys();const b=x=>x.toString("base64url");console.log("VAPID_PUBLIC_KEY="+b(e.getPublicKey()));console.log("VAPID_PRIVATE_KEY="+b(e.getPrivateKey()))'
```

A phone is registered to the address (hostname) it was set up on. If the address of the app changes (for example
to a new domain), every phone must open the new address and turn the alerts on again, and an iPhone's Home Screen
app must be added again.
