#!/bin/bash
# One-time setup of the holdings-mcp LXC. Runs as root (tools/deploy.mjs --provision).
# Idempotent: rerunning it changes nothing that is already in place.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  apt-get update -q
  apt-get install -y -q ca-certificates curl gnupg
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -y -q nodejs
fi
# better-sqlite3 13 ships no prebuilt binaries, so npm ci compiles it.
apt-get install -y -q curl build-essential python3

id holdings >/dev/null 2>&1 || useradd --system --home-dir /var/lib/holdings-mcp --shell /usr/sbin/nologin holdings
install -d -o holdings -g holdings -m 0750 /var/lib/holdings-mcp /var/lib/holdings-mcp/backups
install -d -m 0755 /opt/holdings-mcp /opt/holdings-mcp/releases /etc/holdings-mcp
if [ ! -f /etc/holdings-mcp/env ]; then
  install -m 0640 -g holdings /dev/null /etc/holdings-mcp/env
  cat > /etc/holdings-mcp/env <<'ENV'
HOLDINGS_DB=/var/lib/holdings-mcp/holdings.db
HOLDINGS_HOST=0.0.0.0
HOLDINGS_PORT=8000
HOLDINGS_REFRESH_SECONDS=120
ENV
fi

echo "node=$(node --version)"
echo "provisioned=$(hostname)"
