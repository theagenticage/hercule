#!/bin/sh
# Builds the container image (a no-op when it is current), then builds the
# compiled binary and the desktop app in it and runs the desktop end-to-end
# suite on its virtual screen. Run it from the repository root as
# `pnpm test:desktop:container` on a Linux machine with Docker; any arguments
# go to `vitest`, such as a test file to run on its own.
#
# The commands run as the host user, so the files they write are the host
# user's. They get a scratch HOME inside the container and Docker's default
# network, never the host's. The Docker flags are explained in `Dockerfile`.
set -eu

image=hercule-desktop-linux
cd "$(dirname "$0")/../../.."

docker build --quiet --tag "$image" apps/desktop/container >/dev/null

exec docker run --rm --init --shm-size=1g --security-opt seccomp=unconfined \
  --user "$(id -u):$(id -g)" -e HOME=/tmp/home -v hercule-desktop-cache:/cache \
  -v "$PWD":/repo -w /repo "$image" \
  sh -c 'mkdir -p "$HOME" && pnpm exec playwright install chromium && pnpm build:binary && pnpm build:desktop && pnpm test:desktop "$@"' sh "$@"
