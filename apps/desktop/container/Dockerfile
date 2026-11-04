# A Linux machine with a screen, for running and testing the desktop app on a
# machine that has none, such as a headless server or CI. It holds Ubuntu 24.04,
# the libraries Electron needs, a virtual X screen (Xvfb), a small window
# manager (openbox) and a D-Bus session, which `entry.sh` starts. It holds
# GNOME Keyring too, which the keyring smoke test (`e2e/desktop/keyring.test.ts`)
# starts on a D-Bus session of its own. It also holds the repository's pinned
# Node, Bun and pnpm, so a `node_modules` installed on the host runs in it. The
# repository is mounted, never copied in.
#
# Build, from the repository root:
#
#   docker build -t hercule-desktop-linux apps/desktop/container
#
# Run a command on the virtual screen, as the host user so the files it writes
# are the host user's, with a scratch HOME and the default network (never the
# host's):
#
#   docker run --rm --init --shm-size=1g --security-opt seccomp=unconfined \
#     --user "$(id -u):$(id -g)" -e HOME=/tmp/home -v hercule-desktop-cache:/cache \
#     -v "$PWD":/repo -w /repo hercule-desktop-linux pnpm test:desktop
#
# - `--shm-size` is needed because Chromium keeps shared memory in /dev/shm,
#   and Docker's 64 MB default is too small for it.
# - `seccomp=unconfined` lets Chromium create user namespaces, which its sandbox
#   needs. Docker's default profile blocks that, and the release package, which
#   refuses `--no-sandbox`, then aborts at start. The test package runs without
#   the sandbox (see `buildSandboxArgs` in `scripts/packaged-app.ts`), so only
#   tests of the release package need this.
# - The `hercule-desktop-cache` volume keeps what electron-builder downloads
#   (Electron, and fpm which builds the `.deb`) and Playwright's Chromium
#   between runs. Leave it out and each run downloads them again.
FROM ubuntu:24.04

ARG NODE_VERSION=24.14.0
ARG BUN_VERSION=1.4.4
ARG PNPM_VERSION=10.12.1

ENV DEBIAN_FRONTEND=noninteractive \
    ELECTRON_CACHE=/cache/electron \
    ELECTRON_BUILDER_CACHE=/cache/electron-builder \
    PLAYWRIGHT_BROWSERS_PATH=/cache/playwright

# The first group is what Electron loads at start. The second is the display:
# Xvfb, openbox, D-Bus, and xprop and ImageMagick's `import`, which find the
# window manager and take screenshots of the whole screen; and a keyring,
# gnome-keyring, with `secret-tool` to look inside it. The third is what the
# toolchain downloads and unpacks with. `binutils` is there for `ar`, which
# fpm runs to build a `.deb`. Fonts are DejaVu only, so a
# screenshot does not depend on whatever a host has installed.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libcups2t64 libdrm2 \
      libgbm1 libgtk-3-0t64 libnotify4 libnss3 libsecret-1-0 libx11-xcb1 \
      libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 libxss1 libxtst6 \
      xvfb openbox dbus dbus-x11 x11-utils imagemagick fonts-dejavu-core \
      gnome-keyring libsecret-tools \
      ca-certificates curl unzip xz-utils binutils git \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /tmp/.X11-unix /cache && chmod 1777 /tmp/.X11-unix && chmod 777 /cache

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
    && curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
    && unzip -q -j /tmp/bun.zip -d /usr/local/bin && rm /tmp/bun.zip \
    && npm install --global "pnpm@${PNPM_VERSION}"

ENTRYPOINT ["/repo/apps/desktop/container/entry.sh"]
