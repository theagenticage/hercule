/**
 * The `harness.query` operation: every harness a plugin registered, with what
 * each runner reports about it.
 *
 * A harness is a plugin contribution, so its description is never stored; only
 * the per-runner facts vary at read time.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { Forbidden, Harness, Unauthenticated } from "@hercule/contract";
import { requireGrant } from "../actor";
import { PluginHost } from "../plugins";
import { runnerRepository } from "../runners";
import { buildVersionKey, harnessRepository } from "./repository";
import { computeVersionVerdict, findVersionFloor } from "./version";

const make = Effect.gen(function* () {
  const host = yield* PluginHost;
  const runners = yield* runnerRepository;
  const snapshots = yield* harnessRepository;

  return {
    /**
     * Returns every registered harness, in the order the plugins registered
     * them. Each lists every runner in the fleet, in the order the runners
     * were added. A harness is installed on a runner when the runner's facts
     * list its binary as present. Its version is the one the newest probe
     * reported, and `null` when the harness is not installed there or no probe
     * has seen it.
     */
    query: (): Effect.Effect<ReadonlyArray<Harness>, Unauthenticated | Forbidden | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("harness.query");
        const definitions = yield* host.harnesses();
        const fleet = yield* runners.listFacts();
        const versions = yield* snapshots.readReportedVersions();
        return definitions.map((definition) => ({
          id: definition.id,
          displayName: definition.displayName,
          binaryName: definition.binaryName,
          declared: definition.declared,
          runs: definition.runs,
          runners: fleet.map(({ id: runnerId, facts }) => {
            const installed =
              facts?.harnesses.some(
                (binary) => binary.name === definition.binaryName && binary.present,
              ) ?? false;
            const version = installed
              ? (versions.get(buildVersionKey(definition.id, runnerId)) ?? null)
              : null;
            return {
              runnerId,
              installed,
              version,
              versionVerdict: computeVersionVerdict(version, findVersionFloor(definition.id)),
            };
          }),
        }));
      }),
  };
});

export class HarnessService extends Context.Service<HarnessService, Effect.Success<typeof make>>()(
  "hercule/controller/harnesses/HarnessService",
) {}

export const HarnessServiceLayer: Layer.Layer<
  HarnessService,
  never,
  SqlClient.SqlClient | PluginHost
> = Layer.effect(HarnessService)(make);
