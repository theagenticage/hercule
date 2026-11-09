#!/bin/sh
# Gets the container image (building it only when this machine does not have
# it), then builds the compiled binary and the desktop app in it and runs the
# desktop end-to-end suite on its virtual screen. Run it from the repository
# root as `pnpm test:desktop:container` on a Linux machine with Docker; any
# arguments go to `vitest`, such as test files to run on their own.
#
# The app is built as unpacked folders only (`--unpacked-only`): the tests run
# the executable in place and never read a `.deb` or an Arch package.
#
# The image is named after what it is built from (`image.ts`), so a checkout
# that needs another image gets its own, and never replaces one that another
# checkout on this machine is using. CI pulls it from the registry first.
#
# The commands run as the host user, so the files they write are the host
# user's. They get a scratch HOME inside the container and Docker's default
# network, never the host's. The Docker flags are explained in `Dockerfile`.
set -eu

cd "$(dirname "$0")/../../.."

image=$(node apps/desktop/container/image.ts ensure)

exec docker run --rm --init --shm-size=1g --security-opt seccomp=unconfined \
  --user "$(id -u):$(id -g)" -e HOME=/tmp/home -v hercule-desktop-cache:/cache \
  -v "$PWD":/repo -w /repo "$image" \
  sh -c 'mkdir -p "$HOME" && pnpm build:binary && pnpm build:desktop --unpacked-only && pnpm test:desktop "$@"' sh "$@"
