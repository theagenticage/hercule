/**
 * What this machine says about itself.
 *
 * Only what the operating system already knows: the platform, the architecture
 * and how much memory is fitted. Everything else a runner reports - which
 * toolchains and provider binaries are on the PATH, how much disk is free, and
 * whether docker is there - has to be looked for, and that probe is its own
 * piece of work.
 */
import { arch, platform, totalmem } from "node:os";
import * as Effect from "effect/Effect";
import type { RunnerFacts } from "@hydra/protocol";

/** The loopback port a runner serves `GET /identity` on, before it owns one. */
export const DEFAULT_IDENTITY_PORT = 4939;

/** The facts this build can state without looking for anything. */
export const currentFacts: Effect.Effect<RunnerFacts> = Effect.sync(() => ({
  os: platform(),
  arch: arch(),
  totalMemoryBytes: totalmem(),
  docker: false,
  toolchains: [],
  providers: [],
  identityPort: DEFAULT_IDENTITY_PORT,
}));
