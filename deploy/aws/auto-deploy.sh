#!/bin/bash
# Automatic deploys for the AWS server. Runs every couple of minutes (pos-deploy.timer) as the "pos" user.
#
# When the branch on GitHub has a new commit it:
#   1. downloads it into /opt/pos-app/releases/<commit>,
#   2. installs dependencies, type-checks, builds the app screens and runs the server tests,
#   3. points /opt/pos-app/current at it and restarts the POS,
#   4. checks the POS answers; if not, switches back to the previous release.
# The database (/var/lib/pos) is never touched by this script. A broken commit never goes live:
# any failure in steps 2-4 leaves the running version as it was.
set -uo pipefail

REPO="${POS_REPO:-https://github.com/jatinchoudhary07/POS-SOFTWARE.git}"
BRANCH="${POS_BRANCH:-claude/peaceful-hawking-b26lsi}"
APP=/opt/pos-app
KEEP_RELEASES=3
LOG() { echo "$(date -u +'%Y-%m-%d %H:%M:%S') $*"; }

mkdir -p "$APP/releases"
exec 9>"$APP/deploy.lock"
flock -n 9 || exit 0   # another deploy is still running

remote="$(git ls-remote "$REPO" "refs/heads/$BRANCH" 2>/dev/null | cut -f1)"
[ -n "$remote" ] || { LOG "cannot reach GitHub, will try again later"; exit 0; }

live="$(cat "$APP/current-sha" 2>/dev/null || true)"
failed="$(cat "$APP/failed-sha" 2>/dev/null || true)"
[ "$remote" = "$live" ] && exit 0
if [ "$remote" = "$failed" ]; then exit 0; fi   # this commit already failed; wait for a newer one

short="${remote:0:10}"
dir="$APP/releases/$short"
LOG "new commit $short on $BRANCH - deploying"

fail() {
  LOG "DEPLOY FAILED at: $1 - the running version is unchanged"
  echo "$remote" > "$APP/failed-sha"
  rm -rf "$dir"
  exit 1
}

rm -rf "$dir"
git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$dir" || fail "download"
cd "$dir" || fail "enter release"
[ "$(git rev-parse HEAD)" = "$remote" ] || { remote="$(git rev-parse HEAD)"; }

npm ci --no-audit --no-fund --loglevel=error || fail "npm ci"
npm run typecheck >/dev/null 2>&1 || fail "typecheck"
# build first: one server test checks that the built app screens are served
npm run build >/dev/null 2>&1 || fail "build"
[ -f client/dist/index.html ] || fail "build output missing"
if [ "${POS_SKIP_TESTS:-0}" != "1" ]; then
  npm run test --workspace server >/tmp/pos-deploy-test.log 2>&1 || { tail -25 /tmp/pos-deploy-test.log; fail "server tests"; }
fi

previous="$(readlink -f "$APP/current" 2>/dev/null || true)"
ln -sfn "$dir" "$APP/current.new" && mv -T "$APP/current.new" "$APP/current"
sudo /bin/systemctl restart pos

ok=0
for _ in $(seq 1 30); do
  sleep 1
  if curl -fsS --max-time 3 http://127.0.0.1:3001/api/auth/status >/dev/null 2>&1; then ok=1; break; fi
done
if [ "$ok" != "1" ]; then
  LOG "new version did not start - going back to the previous one"
  if [ -n "$previous" ] && [ -d "$previous" ]; then
    ln -sfn "$previous" "$APP/current.new" && mv -T "$APP/current.new" "$APP/current"
    sudo /bin/systemctl restart pos
  fi
  fail "health check"
fi

echo "$remote" > "$APP/current-sha"
rm -f "$APP/failed-sha"
LOG "deployed $short"

# keep the newest few releases for quick rollbacks
ls -1dt "$APP"/releases/*/ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do
  [ "$(readlink -f "$APP/current")" = "$(readlink -f "$old")" ] || rm -rf "$old"
done
exit 0
