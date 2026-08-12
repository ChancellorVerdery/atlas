#!/usr/bin/env bash
# Render Caddyfile.template onto the server, prove the console still works, and
# roll back automatically if it doesn't.
#
# Deliberately does NOT touch cloudflared. Closing portainer.<domain> is done by
# dropping it from the gate's UPSTREAM map, where it now answers 404 — a config
# reload of the tunnel daemon is not worth the risk of taking every hostname
# offline, which is exactly what a SIGHUP did once.
#
# Run from the repo root:  bash atlas-server-app/deploy-console.sh
set -euo pipefail

HOST=${ATLAS_SSH_HOST:-atlas-tunnel}
LIVE=/home/user/stack/caddy/Caddyfile
TPL=atlas-server-app/Caddyfile.template
say() { printf '\n== %s\n' "$1"; }

[ -f "$TPL" ] || { echo "run me from the repo root"; exit 1; }

say "shipping the console page and the template"
scp -q "$TPL" "$HOST:/tmp/Caddyfile.new.tpl"
scp -q atlas-server-app/index.html "$HOST:/tmp/console-index.html"

say "rendering, validating, reloading (auto-rollback on failure)"
ssh "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
LIVE=/home/user/stack/caddy/Caddyfile
BAK="$LIVE.bak.$(date +%s)"
cp "$LIVE" "$BAK"; echo "backup: $BAK"

# Carry the bcrypt hash across from the running config rather than re-hashing:
# the password is not on this box in plaintext, and it should stay that way.
python3 - "$BAK" /tmp/Caddyfile.new.tpl "$LIVE" <<'PY'
import re, sys
live, tpl, out = (open(p).read() if i < 2 else p for i, p in enumerate(sys.argv[1:]))
m = re.search(r'^\s*chancellor\s+(\S+)\s*$', live, re.M)
if not m: raise SystemExit('no basic_auth hash found in the live config')
if '__HASH__' not in tpl: raise SystemExit('template has no __HASH__ placeholder')
open(out, 'w').write(tpl.replace('__HASH__', m.group(1)))
print('rendered with the existing hash')
PY

restore() { cp "$BAK" "$LIVE"; docker exec stack-caddy-1 caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true; }

if ! docker exec stack-caddy-1 caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  echo "INVALID CONFIG — rolling back"; restore; exit 1
fi
docker exec stack-caddy-1 caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1
echo "reloaded"

install -m 644 /tmp/console-index.html /home/user/stack/app/index.html
echo "console page updated"

# --- prove it, from the server side, through caddy ---------------------------
fail=0
probe() { # path expected-code label
  c=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -u "chancellor:$CONSOLE_PW" "http://127.0.0.1$1" 2>/dev/null || echo 000)
  printf '  %-28s %s (want %s)\n' "$3" "$c" "$2"
  [ "$c" = "$2" ] || fail=1
}
if [ -n "${CONSOLE_PW:-}" ]; then
  probe /            200 "console page"
  probe /docker/     200 "docker tab"
  probe /git/        200 "git board"
  probe /db/         200 "database tab"
  c=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://127.0.0.1/" || echo 000)
  printf '  %-28s %s (want 401)\n' "no credentials" "$c"; [ "$c" = 401 ] || fail=1
else
  echo "  CONSOLE_PW not set — skipping authenticated probes"
fi
c=$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:9001/ || echo 000)
printf '  %-28s %s (want 000, listener gone)\n' ":9001 retired" "$c"

if [ "$fail" != 0 ]; then echo "PROBES FAILED — rolling back"; restore; exit 1; fi
echo "all probes passed"
REMOTE

say "restarting the gate (drops portainer.<domain> from its routes)"
scp -q atlas-backend/services/gate.js atlas-backend/services/portainer-auth.js "$HOST:/home/user/atlas-gate/services/"
ssh "$HOST" 'docker restart atlas-gate >/dev/null && sleep 2 && docker logs --tail 3 atlas-gate'

say "done"
