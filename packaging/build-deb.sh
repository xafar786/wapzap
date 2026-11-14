#!/bin/bash
# Builds dist/wapzap_<version>_<arch>.deb - a self-contained Ubuntu package.
# The package includes its own copy of Node.js, so the target machine needs nothing else.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
ARCH="$(dpkg --print-architecture)"
NODE_BIN="$(readlink -f "$(command -v node)")"
OUT="$ROOT/dist/wapzap_${VERSION}_${ARCH}.deb"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "Building WAPZAP $VERSION for $ARCH with Node $(node -v)"

APP="$STAGE/opt/wapzap"
mkdir -p "$APP" "$STAGE/DEBIAN" "$STAGE/usr/bin" \
  "$STAGE/usr/share/applications" "$STAGE/usr/share/icons/hicolor/scalable/apps"

# The app itself.
cp -r server.js package.json package-lock.json src public sample-contacts.csv "$APP/"
# Only the libraries needed to run (no dev tools), installed fresh from the lock file.
(cd "$APP" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
# Bundled Node.js runtime.
install -m 755 "$NODE_BIN" "$APP/node"

install -m 755 packaging/wapzap "$STAGE/usr/bin/wapzap"
install -m 644 packaging/wapzap.desktop "$STAGE/usr/share/applications/wapzap.desktop"
install -m 644 packaging/wapzap.svg "$STAGE/usr/share/icons/hicolor/scalable/apps/wapzap.svg"

# Normal permissions: everyone can read, only root can change.
chmod -R u=rwX,go=rX "$STAGE"

SIZE_KB="$(du -sk "$STAGE" | cut -f1)"
cat >"$STAGE/DEBIAN/control" <<EOF
Package: wapzap
Version: $VERSION
Section: net
Priority: optional
Architecture: $ARCH
Depends: libc6, libstdc++6, libgcc-s1, libatomic1, xdg-utils, curl, ffmpeg
Recommends: libnotify-bin, google-chrome-stable | chromium-browser | chromium
Installed-Size: $SIZE_KB
Maintainer: WAPZAP <wapzap@localhost>
Description: Personalised WhatsApp messages in bulk
 WAPZAP is a local web app for sending personalised WhatsApp messages
 from a CSV contact list, with daily limits, sending windows and random
 delays. It runs only on this computer and stores its data in
 ~/.local/share/wapzap.
EOF

# Stop a running copy before an upgrade or removal so files are not swapped underneath it.
cat >"$STAGE/DEBIAN/prerm" <<'EOF'
#!/bin/sh
pkill -f '^/opt/wapzap/node /opt/wapzap/server.js' 2>/dev/null || true
exit 0
EOF
chmod 755 "$STAGE/DEBIAN/prerm"

mkdir -p "$ROOT/dist"
dpkg-deb --build --root-owner-group "$STAGE" "$OUT" >/dev/null
echo "Done: $OUT ($(du -h "$OUT" | cut -f1))"
