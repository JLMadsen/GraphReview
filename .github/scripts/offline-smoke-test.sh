#!/usr/bin/env bash
# Starts an offline bundle in a container with no network at all, adds a
# small local repo and waits for its static analysis to finish — so the app,
# its native modules and the tree-sitter grammars all come from the bundle.
#
# Usage: .github/scripts/offline-smoke-test.sh <graphreview-…-linux-x64.tar.gz>
# Needs Docker. The container image only provides git and curl; Node.js and
# everything else must come from the bundle.
set -euo pipefail

bundle=$(cd "$(dirname "${1:?usage: offline-smoke-test.sh <bundle.tar.gz>}")" && pwd)/$(basename "$1")

docker run --rm -i --network none -e NAME="$(basename "$bundle" .tar.gz)" \
  -v "$bundle:/bundle.tar.gz:ro" buildpack-deps:bookworm-scm bash -s <<'SCRIPT'
set -euo pipefail
tar -xzf /bundle.tar.gz -C /opt
app=/opt/$NAME
node=$app/node/bin/node
url=http://127.0.0.1:3470
"$app/graphreview" --version

"$app/graphreview" --no-open --data /tmp/graphreview > /tmp/log 2>&1 &
fail() { cat /tmp/log; echo "smoke test: $1" >&2; exit 1; }

for i in $(seq 1 60); do
  curl -fs -o /dev/null "$url/" && break
  [ "$i" = 60 ] && fail "GraphReview did not come up within 60 s"
  sleep 1
done
echo "smoke test: start page served"

mkdir -p /tmp/sample/src && cd /tmp/sample
cat > src/util.ts <<'TS'
export function add(a: number, b: number): number { return a + b; }
TS
cat > src/main.ts <<'TS'
import { add } from "./util";
export function total(values: number[]): number { return values.reduce(add, 0); }
TS
git init -q -b main && git add . && git -c user.name=ci -c user.email=ci@localhost commit -qm init

repo=$(curl -fsS -X POST "$url/api/repos" -H "Origin: $url" -H "Content-Type: application/json" \
  -d '{"provider":"local","localPath":"/tmp/sample"}') || fail "adding the repo failed"
id=$(echo "$repo" | "$node" -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).id')

for i in $(seq 1 120); do
  status=$(curl -fsS "$url/api/repos/$id" | "$node" -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).status')
  case "$status" in
    up_to_date) echo "smoke test: local repo analysed"; cat /tmp/log; exit 0 ;;
    error) curl -fsS "$url/api/repos/$id?logs=1"; echo; fail "analysis failed" ;;
  esac
  sleep 1
done
fail "analysis did not finish within 120 s (status: $status)"
SCRIPT
