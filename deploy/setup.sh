#!/usr/bin/env bash
# One-shot server setup for SPHEREx Space Maps on Ubuntu 24.04 (run as root: sudo bash setup.sh).
# Idempotent: safe to re-run. Installs security updates, swap, uv, Caddy (auto HTTPS),
# clones the app, and runs it as an unprivileged systemd service behind Caddy.
set -euo pipefail

DOMAIN="${DOMAIN:-spacemaps.vinayakarora.com}"
REPO="${REPO:-https://github.com/Vinayak-Arora-324/Nasa-Space-Apps-Planetx-And-SphereX.git}"
BRANCH="${BRANCH:-main}"
APP_USER=blink
APP_HOME=/opt/blink
APP_DIR=$APP_HOME/app
CACHE_DIR=/var/lib/blink/cache
HERE="$(cd "$(dirname "$0")" && pwd)"

export DEBIAN_FRONTEND=noninteractive

echo "== security updates"
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confold full-upgrade
apt-get -y -q install git curl rsync caddy unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "== 2 GB swap (headroom so a big job slows down instead of being OOM-killed)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -q -w vm.swappiness=10
echo 'vm.swappiness=10' > /etc/sysctl.d/90-blink.conf

echo "== uv"
if ! command -v uv >/dev/null; then
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh
fi

echo "== app user, code and cache"
id -u $APP_USER >/dev/null 2>&1 || useradd --system --create-home --home-dir $APP_HOME --shell /usr/sbin/nologin $APP_USER
install -d -o $APP_USER -g $APP_USER $CACHE_DIR
if [ ! -d $APP_DIR/.git ]; then
  sudo -u $APP_USER git clone --branch "$BRANCH" --depth 1 "$REPO" $APP_DIR
else
  sudo -u $APP_USER git -C $APP_DIR fetch --depth 1 origin "$BRANCH"
  sudo -u $APP_USER git -C $APP_DIR reset --hard FETCH_HEAD
fi
cd $APP_DIR
sudo -u $APP_USER env HOME=$APP_HOME uv sync --frozen --no-dev

echo "== systemd service"
install -m 644 "$HERE/blink.service" /etc/systemd/system/blink.service
systemctl daemon-reload
systemctl enable blink
systemctl restart blink

echo "== Caddy"
sed "s/__DOMAIN__/$DOMAIN/g" "$HERE/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

echo "== auto-deploy from GitHub ($BRANCH, every 5 min)"
install -m 755 "$HERE/autodeploy.sh" /usr/local/sbin/blink-autodeploy
sed "s/^Environment=BRANCH=.*/Environment=BRANCH=$BRANCH/" "$HERE/blink-autodeploy.service" \
  > /etc/systemd/system/blink-autodeploy.service
install -m 644 "$HERE/blink-autodeploy.timer" /etc/systemd/system/blink-autodeploy.timer
systemctl daemon-reload
systemctl enable --now blink-autodeploy.timer

echo "== waiting for the app"
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8000/api/health >/dev/null 2>&1; then echo "app is up"; break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:8000/api/health && echo
echo "done: https://$DOMAIN (once DNS points here)"
