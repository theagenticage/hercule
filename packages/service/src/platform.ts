/**
 * Chooses the Supervisor of this machine: launchd on macOS, systemd on Linux.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import type { Env } from "@hercule/home";
import { createLaunchdSupervisor } from "./launchd";
import { ServiceError, Supervisor, runCommand } from "./supervisor";
import { createSystemdSupervisor, locateSystemdUnitDir } from "./systemd";

/**
 * Returns a layer that provides the Supervisor of this machine, given the
 * environment of the command that asks for it: launchd on macOS, systemd on
 * Linux. Building the layer fails with `ServiceError` on any other platform.
 */
export const makeSupervisorLayer = (env: Env): Layer.Layer<Supervisor, ServiceError> =>
  Layer.effect(
    Supervisor,
    Effect.suspend(() => {
      const uid = process.getuid?.() ?? 0;
      // Only for messages. Bun's `userInfo()` reads `$USER` too, and reports
      // "unknown" where it is unset, as under `sudo -u` or in a container.
      const userName = env["USER"] ?? env["LOGNAME"];
      switch (process.platform) {
        case "darwin":
          return Effect.succeed(
            createLaunchdSupervisor({
              run: runCommand,
              unitDir: join(homedir(), "Library", "LaunchAgents"),
              uid,
              userName,
            }),
          );
        case "linux":
          return Effect.succeed(
            createSystemdSupervisor({
              run: runCommand,
              unitDir: locateSystemdUnitDir(env, homedir()),
              uid,
              userName,
            }),
          );
        default:
          return Effect.fail(
            new ServiceError({
              message: `Hercule installs a service on macOS and Linux only, and this machine runs ${process.platform}. Start \`hercule serve\` or \`hercule runner\` by hand instead.`,
            }),
          );
      }
    }),
  );
