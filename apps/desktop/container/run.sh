#!/bin/sh
# Builds the compiled binary and the desktop app in the container, then runs
# the desktop end-to-end suite on its virtual screen. Run it from the
# repository root as `pnpm test:desktop:container`, on Linux or macOS with
# Docker; any arguments go to `vitest`, such as test files to run on their own.
#
# The app is built as unpacked folders only (`build:desktop:unpacked`): the tests run
# the executable in place and never read a `.deb` or an Arch package.
#
# `run.ts` gets the container image (building it only when this machine does
# not have it) for this machine's own architecture, and on macOS runs in a copy
# of the checkout with its own Linux `node_modules`. The image is named after
# what it is built from (`image.ts`), so a checkout that needs another image
# gets its own, and never replaces one that another checkout on this machine is
# using. CI loads it from the Actions cache first.
set -eu

cd "$(dirname "$0")/../../.."

exec node apps/desktop/container/run.ts -- \
  sh -c 'pnpm build:binary && pnpm build:desktop:unpacked && pnpm test:desktop "$@"' sh "$@"
