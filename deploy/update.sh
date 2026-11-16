#!/usr/bin/env bash
# Pull the latest code onto the server and restart. Run from your machine:
#   bash deploy/update.sh            (deploys origin/main)
#   BRANCH=my-branch bash deploy/update.sh
set -euo pipefail
HOST="${HOST:-blink}"
BRANCH="${BRANCH:-main}"
ssh "$HOST" "sudo -u blink git -C /opt/blink/app fetch --depth 1 origin '$BRANCH' \
  && sudo -u blink git -C /opt/blink/app reset --hard FETCH_HEAD \
  && cd /opt/blink/app && sudo -u blink env HOME=/opt/blink uv sync --frozen --no-dev \
  && sudo systemctl restart blink \
  && sleep 3 && curl -fsS http://127.0.0.1:8000/api/health && echo"
