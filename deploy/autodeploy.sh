#!/usr/bin/env bash
# Deploy the latest commit of $BRANCH when it differs from what is running.
# Run as root by blink-autodeploy.timer. If the new version fails its health check,
# the previous commit is restored and restarted.
set -euo pipefail

BRANCH="${BRANCH:-main}"
APP_DIR=/opt/blink/app
HEALTH=http://127.0.0.1:8000/api/health
as_blink() { sudo -u blink env HOME=/opt/blink "$@"; }

exec 9>/run/blink-autodeploy.lock
flock -n 9 || { echo "another deploy is running"; exit 0; }

cd "$APP_DIR"
as_blink git fetch --quiet --depth 1 origin "$BRANCH"
old=$(as_blink git rev-parse HEAD)
new=$(as_blink git rev-parse FETCH_HEAD)
[ "$old" = "$new" ] && exit 0

echo "deploying $BRANCH ${old:0:7} -> ${new:0:7}: $(as_blink git log -1 --format=%s FETCH_HEAD)"

healthy() {
  for _ in $(seq 1 60); do
    curl -fsS --max-time 2 "$HEALTH" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

switch_to() {
  as_blink git reset --quiet --hard "$1"
  as_blink uv sync --quiet --frozen --no-dev
  systemctl restart blink
}

if switch_to "$new" && healthy; then
  echo "deployed ${new:0:7}"
else
  echo "deploy of ${new:0:7} failed its health check; rolling back to ${old:0:7}" >&2
  as_blink git fetch --quiet origin "$old" || true
  switch_to "$old"
  healthy && echo "rolled back to ${old:0:7}" || echo "rollback is unhealthy too" >&2
  exit 1
fi
