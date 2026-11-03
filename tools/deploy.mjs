#!/usr/bin/env node
// Deploys holdings-mcp to its LXC (holdings-mcp.localdomain), on quote-mcp's pattern: SSH as the shared
// `authoring` login, one `sudo -S` call per step with the password piped on stdin, a release directory
// per deploy, a health check, and rollback to the previous release on failure.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOST = process.env.HOLDINGS_DEPLOY_HOST ?? "authoring@holdings-mcp.localdomain";
const ASKPASS = path.join(root, "tools", "askpass.mjs");
const ENV_NAMES = ["HOLDINGS_ZOTERO_LIBRARIES", "HOLDINGS_ZOTERO_API_KEY", "HOLDINGS_BOOKS_URL", "HOLDINGS_COUNTS_URL", "ACCESS_TEAM_DOMAIN"];

const USAGE = `Usage: npm run deploy -- [--provision | --env] [--skip-tests]

  (no flag)        build, test, install this checkout as a new release, restart, health-check, roll
                   back on failure, and record the branch and commit in /var/lib/holdings-mcp/deployed.json
                   (the server's /health reports it); the first deploy also runs the first refresh
  --provision      one-time setup of the LXC (Node 22, build tools, holdings user, directories)
  --env            copy the server's settings from .env into its /etc/holdings-mcp/env (mode 0640) and
                   restart: ${ENV_NAMES.join(", ")}.
                   Only those set in .env are replaced; the server's others are left as they are
  --skip-tests     deploy without running the test suite first

Needs AUTHORING_DEPLOY_PASSWORD in .env.`;

const password = process.env.AUTHORING_DEPLOY_PASSWORD;
const sshOptions = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10"];

function sshEnv() {
  return { ...process.env, SSH_ASKPASS: ASKPASS, SSH_ASKPASS_REQUIRE: "force", DISPLAY: process.env.DISPLAY || "holdings-deploy" };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Runs a bash script as root on the host; resolves with its stdout (also echoed). */
function runAsRoot(script) {
  const encoded = Buffer.from(script).toString("base64");
  const command = `sudo -S -p '' bash -c "$(printf %s '${encoded}' | base64 -d)"`;
  return new Promise((resolve, reject) => {
    const ssh = spawn("ssh", [...sshOptions, HOST, command], { env: sshEnv(), stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    ssh.stdout.on("data", (chunk) => {
      out += chunk;
      process.stdout.write(chunk);
    });
    ssh.stdin.end(`${password}\n`);
    ssh.on("error", reject);
    ssh.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${HOST}: remote script exited with ${code}`))));
  });
}

/** Runs the CLI on the server as the holdings user, with the server's environment. */
const asHoldings = (args) => `runuser -u holdings -- bash -c 'set -a; . /etc/holdings-mcp/env; set +a; cd /opt/holdings-mcp/current && node dist/cli.js ${args}'`;

async function provision() {
  await runAsRoot(fs.readFileSync(path.join(root, "deploy", "provision.sh"), "utf8"));
  console.log("\nProvisioned. Next: npm run deploy -- --env, then npm run deploy");
}

/** Sets the server's settings from this machine's .env, so keys never pass through a chat or a command line. */
async function pushEnv() {
  const names = ENV_NAMES.filter((n) => process.env[n]?.trim());
  if (!names.length) throw new Error(`None of ${ENV_NAMES.join(", ")} is set in .env.`);
  console.log(`Setting ${names.join(", ")} on the server; leaving ${ENV_NAMES.filter((n) => !names.includes(n)).join(", ") || "nothing else"} as it is.`);
  const lines = names.map((n) => `${n}=${process.env[n].trim()}`).join("\n");
  const encoded = Buffer.from(`${lines}\n`).toString("base64");
  await runAsRoot(`
set -euo pipefail
f=/etc/holdings-mcp/env
grep -v ${names.map((n) => `-e '^${n}='`).join(" ")} "$f" > "$f.new" || true
printf %s ${shellQuote(encoded)} | base64 -d >> "$f.new"
chown root:holdings "$f.new" && chmod 0640 "$f.new" && mv "$f.new" "$f"
cut -d= -f1 "$f" | tr '\\n' ' '; echo
systemctl is-active --quiet holdings-mcp.service || exit 0
systemctl restart holdings-mcp.service
set -a; . "$f"; set +a
for i in $(seq 1 20); do
  if curl -sf -o /dev/null "http://127.0.0.1:$HOLDINGS_PORT/health"; then echo "holdings-mcp is back up."; exit 0; fi
  sleep 1
done
journalctl -u holdings-mcp.service -n 20 --no-pager || true
echo "holdings-mcp didn't answer /health within 20 seconds of the restart." >&2
exit 1`);
}

async function deploy({ skipTests }) {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  if (!skipTests) execFileSync("npm", ["test"], { cwd: root, stdio: "inherit" });

  const id = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const tarball = path.join(os.tmpdir(), `holdings-mcp-${id}.tgz`);
  execFileSync("tar", ["czf", tarball, "-C", root, "dist", "deploy", "package.json", "package-lock.json"]);
  execFileSync("scp", [...sshOptions, tarball, `${HOST}:/tmp/`], { env: sshEnv(), stdio: "inherit" });
  fs.rmSync(tarball);

  await runAsRoot(`
set -euo pipefail
release=/opt/holdings-mcp/releases/${id}
mkdir -p "$release"
tar xzf /tmp/holdings-mcp-${id}.tgz -C "$release"
rm -f /tmp/holdings-mcp-${id}.tgz
cd "$release"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
set -a; . /etc/holdings-mcp/env; set +a
previous=$(readlink /opt/holdings-mcp/current || true)
echo "previous=$previous"
fresh_store=""
# Chained with && so it fails at the first failing step even where set -e doesn't apply (in rollback's if).
install_units() {
  install -m 0644 "$1/deploy/holdings-mcp.service" "$1/deploy/holdings-backup.service" "$1/deploy/holdings-backup.timer" /etc/systemd/system/ \\
    && install -m 0755 "$1/deploy/holdings-mcp" /usr/local/bin/holdings-mcp \\
    && systemctl daemon-reload
}
# From the switch on, any failure puts the previous release (and its units) back, and a first store that
# didn't finish its first refresh is removed, so the next deploy runs it again.
rollback() {
  status=$?
  [ "$status" -eq 0 ] && return
  journalctl -u holdings-mcp.service -n 20 --no-pager || true
  if [ -n "$fresh_store" ]; then
    systemctl stop holdings-mcp.service || true
    rm -f "$HOLDINGS_DB" "$HOLDINGS_DB-wal" "$HOLDINGS_DB-shm"
    echo "removed the unfinished first store"
  fi
  if [ -n "$previous" ]; then
    ln -sfn "$previous" /opt/holdings-mcp/current
    if install_units "$previous"; then
      systemctl restart holdings-mcp.service || echo "holdings-mcp didn't restart on $previous"
      echo "rolled_back=$previous"
    else
      echo "rollback_incomplete=$previous: its units couldn't all be put back"
    fi
  fi
  exit "$status"
}
trap rollback EXIT
ln -sfn "$release" /opt/holdings-mcp/current.new && mv -T /opt/holdings-mcp/current.new /opt/holdings-mcp/current
install_units "$release"
if [ ! -f "$HOLDINGS_DB" ]; then
  echo "No store yet: running the first refresh."
  fresh_store=1
  ${asHoldings("refresh --rebuild")}
else
  ${asHoldings("migrate")}
fi
systemctl enable --quiet holdings-mcp.service holdings-backup.timer
systemctl start holdings-backup.timer
systemctl restart holdings-mcp.service
for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$HOLDINGS_PORT/health"; then echo; echo "installed=${id}"; break; fi
  sleep 1
done
curl -sf -o /dev/null "http://127.0.0.1:$HOLDINGS_PORT/health"
trap - EXIT
ls -1dt /opt/holdings-mcp/releases/* | tail -n +4 | xargs -r rm -rf
`);
  await writeDeployed({ branch: git(["rev-parse", "--abbrev-ref", "HEAD"]), commit: git(["rev-parse", "HEAD"]), local: true, dirty: git(["status", "--porcelain"]) !== "" });
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

const DEPLOYED = "/var/lib/holdings-mcp/deployed.json";

/** Records what the server now runs ({ branch, commit, local, dirty, at }), for /health. */
async function writeDeployed(record) {
  const encoded = Buffer.from(JSON.stringify({ ...record, at: new Date().toISOString() })).toString("base64");
  await runAsRoot(`printf %s ${shellQuote(encoded)} | base64 -d > ${DEPLOYED}.new && chmod 0644 ${DEPLOYED}.new && mv ${DEPLOYED}.new ${DEPLOYED} && echo`);
}

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return console.log(USAGE);
  const known = new Set(["--provision", "--env", "--skip-tests"]);
  const unknown = argv.find((a) => !known.has(a));
  if (unknown) throw new Error(`Unknown argument ${unknown}.\n\n${USAGE}`);
  if (!password) throw new Error(`AUTHORING_DEPLOY_PASSWORD is not set.\n\n${USAGE}`);
  if (argv.includes("--provision")) return provision();
  if (argv.includes("--env")) return pushEnv();
  return deploy({ skipTests: argv.includes("--skip-tests") });
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
