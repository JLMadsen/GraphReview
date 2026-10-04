#!/usr/bin/env bash
# Builds the offline bundle: GraphReview ready to run on a Linux x64 machine
# with no internet and no npm registry. One folder, packed as a .tar.gz:
#
#   graphreview-<version>-linux-x64/
#     graphreview          start script (put it on PATH, or run it in place)
#     node/                the Node.js the app runs on
#     app/                 the npm package's files + its production node_modules
#     app/preview-harness/ the before/after preview harness, pre-installed
#     README.txt
#
# Usage: .github/scripts/offline-bundle.sh <output dir>
# Run on Linux x64 (native modules in node_modules are built for the machine
# this runs on), from the repo root, after `npm ci`. Needs curl and xz.
set -euo pipefail

out=$(mkdir -p "${1:?usage: offline-bundle.sh <output dir>}" && cd "$1" && pwd)
version=$(node -p "require('./package.json').version")
node_version=$(node -p "process.version")
name="graphreview-${version}-linux-x64"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
dest="$work/$name"
mkdir -p "$dest"

echo "==> Building and packing GraphReview $version"
# The same files `npm publish` ships (prepack runs the production build).
npm pack --pack-destination "$work" --loglevel=warn >/dev/null
tar -xzf "$work/graphreview-${version}.tgz" -C "$work"
mv "$work/package" "$dest/app"

echo "==> Installing production dependencies"
cp package-lock.json "$dest/app/"
(cd "$dest/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
# Not needed to run the built app (about 280 MB): Next's SWC compiler is only
# used by `next build` (Next's own standalone output leaves it out too), and
# the musl (Alpine) builds of native modules are dead weight next to the
# glibc ones this bundle targets.
rm -rf "$dest/app/node_modules/@next/"swc-* "$dest/app/node_modules/@img/"*linuxmusl*

echo "==> Installing the preview harness"
mkdir -p "$dest/app/preview-harness"
harness_packages=$(node -p "require('./lib/preview/harness/packages.json').packages.join(' ')")
(cd "$dest/app/preview-harness" &&
  echo '{"name":"graphreview-preview-harness","private":true}' > package.json &&
  npm install --no-audit --no-fund --loglevel=error $harness_packages)

echo "==> Adding Node.js $node_version"
curl -fsSL "https://nodejs.org/dist/${node_version}/node-${node_version}-linux-x64.tar.xz" | tar -xJ -C "$work"
mkdir -p "$dest/node/bin"
cp "$work/node-${node_version}-linux-x64/bin/node" "$dest/node/bin/"
cp "$work/node-${node_version}-linux-x64/LICENSE" "$dest/node/"

cat > "$dest/graphreview" <<'SH'
#!/bin/sh
# Starts GraphReview with the Node.js bundled next to this script. Works when
# symlinked onto PATH (e.g. ln -s "$PWD/graphreview" ~/.local/bin/).
dir=$(dirname "$(readlink -f "$0")")
exec "$dir/node/bin/node" "$dir/app/bin/graphreview.mjs" "$@"
SH
chmod +x "$dest/graphreview"

cat > "$dest/README.txt" <<TXT
GraphReview ${version} — offline bundle for Linux x64
Bundled Node.js ${node_version}. Needs git on PATH, and glibc 2.28+
(Debian 10, Ubuntu 20.04, RHEL 8 or newer).

Start it:

  ./graphreview              (options: --port <n>, --data <dir>, --no-open, --help)

Put it on PATH:

  ln -s "\$PWD/graphreview" ~/.local/bin/graphreview

Data lives in ~/.graphreview, not in this folder, so upgrading is replacing
this folder with the new one.

Before/after previews (optional) need Docker. Load the preview image from the
release once (or have it on your registry mirror, see PREVIEW_IMAGE_REGISTRY
in ~/.graphreview/config.env):

  docker load -i graphreview-preview-image-node22.tar.gz

The preview harness is included. Previewing a repo still installs that repo's
own dependencies, which needs an npm registry mirror (NPM_CONFIG_REGISTRY in
config.env, or your ~/.npmrc).
TXT

echo "==> Packing"
tar -czf "$out/$name.tar.gz" -C "$work" "$name"
echo "$out/$name.tar.gz ($(du -h "$out/$name.tar.gz" | cut -f1))"
