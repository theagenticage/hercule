# A Linux machine with a native Wayland compositor, for running the desktop app
# on Wayland where no Wayland desktop is at hand. It holds Arch Linux, the
# libraries Electron needs, sway (headless, on the pixman renderer, with
# XWayland), Hyprland, GNOME Keyring, `grim` for screenshots and `wtype` for
# keys, and the repository's pinned Node, Bun and pnpm. `entry.sh` starts sway
# on a D-Bus session and runs a command inside it. Hyprland is installed
# because it was tried first: its headless backend does not start in a
# container (Hyprland 0.57.1 ends with "CBackend::create() failed"), so sway is
# the compositor that runs.
#
# Build, from the repository root:
#
#   docker build -t hercule-desktop-wayland apps/desktop/container/wayland
#
# Run a command in a Wayland session, as the host user with a scratch HOME:
#
#   docker run --rm --init --shm-size=1g --security-opt seccomp=unconfined \
#     --cap-add SYS_NICE --device /dev/dri --group-add "$(stat -c %g /dev/dri/renderD128)" \
#     --user 1000:1000 -e HOME=/tmp/home -v hercule-desktop-cache:/cache \
#     -v "$PWD":/repo -w /repo hercule-desktop-wayland \
#     /repo/apps/desktop/container/wayland/entry.sh pnpm test:desktop
#
# - `--cap-add SYS_NICE` is needed because sway's binary carries that file
#   capability, and a container without it cannot start the binary.
# - `--device /dev/dri` gives Chromium the render node that its Wayland
#   platform looks for. Without one the GPU process exits at start.
# - `--user 1000:1000` matches the user made below, so D-Bus and the compositor
#   find a passwd entry. Use the host user's id if it differs, and change the
#   `useradd` line to it.
# - Environment variables for `entry.sh` are described in its comment.
FROM archlinux:latest

ARG NODE_VERSION=24.14.0
ARG BUN_VERSION=1.4.4
ARG PNPM_VERSION=10.12.1

ENV ELECTRON_CACHE=/cache/electron \
    ELECTRON_BUILDER_CACHE=/cache/electron-builder

RUN pacman -Syu --noconfirm --needed --disable-sandbox \
      gtk3 nss alsa-lib libcups libdrm mesa libxss libxtst libxkbcommon libnotify libsecret \
      at-spi2-core xorg-xwayland hyprland sway grim wtype dbus gnome-keyring \
      xorg-xprop xorg-xwininfo xdotool imagemagick ttf-dejavu \
      curl unzip xz binutils git procps-ng psmisc \
    && pacman -Scc --noconfirm

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
    && curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
    && unzip -q -j /tmp/bun.zip -d /usr/local/bin && rm /tmp/bun.zip \
    && npm install --global "pnpm@${PNPM_VERSION}"

RUN useradd -u 1000 -M -d /tmp/home hercule

# The cache volume copies this folder's owner and mode when it is first made,
# so a fresh volume is writable by the user the container runs as.
RUN mkdir -p /cache && chmod 777 /cache
