#!/bin/bash
# One-time setup on the AWS server (run as root):  sudo bash install-auto-deploy.sh
# Installs the auto-deploy script and its timer, and points the POS service at /opt/pos-app/current.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

install -m 0755 "$HERE/auto-deploy.sh" /usr/local/bin/pos-auto-deploy
sed -i 's/\r$//' /usr/local/bin/pos-auto-deploy

mkdir -p /opt/pos-app/releases
chown -R pos:pos /opt/pos-app /opt/pos

# the deploy user may restart only the POS service
cat > /etc/sudoers.d/pos-deploy <<'EOF'
pos ALL=(root) NOPASSWD: /bin/systemctl restart pos
EOF
chmod 440 /etc/sudoers.d/pos-deploy
visudo -cf /etc/sudoers.d/pos-deploy >/dev/null

cat > /etc/systemd/system/pos-deploy.service <<'EOF'
[Unit]
Description=Deploy the latest Two Hearts Cafe POS from GitHub
After=network-online.target

[Service]
Type=oneshot
User=pos
Group=pos
Environment=HOME=/opt/pos
Nice=10
TimeoutStartSec=1200
ExecStart=/usr/local/bin/pos-auto-deploy
StandardOutput=append:/var/log/pos-deploy.log
StandardError=append:/var/log/pos-deploy.log
EOF

cat > /etc/systemd/system/pos-deploy.timer <<'EOF'
[Unit]
Description=Check GitHub for a new POS version every 2 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
AccuracySec=15s

[Install]
WantedBy=timers.target
EOF

touch /var/log/pos-deploy.log && chown pos:pos /var/log/pos-deploy.log
systemctl daemon-reload
echo "installed. Next: run the first deploy (sudo -u pos /usr/local/bin/pos-auto-deploy), point pos.service at /opt/pos-app/current/server, then: systemctl enable --now pos-deploy.timer"
