/**
 * Installing a harness on a runner: `runner.installHarness`.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createDecodeValidationError,
  createInvalidStateError,
  createValidationError,
  Id,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type RunnerDetail,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { requireGrant } from "../../actor";
import { PluginHost } from "../../plugins";
import { ProviderAccountProbing } from "../provider-accounts";
import {
  readRunnerOrFail,
  requireAdapter,
  RunnerConnections,
  runnerRepository,
} from "../../runners";

/**
 * The runner's own 5min installer timeout plus the round trip, so a runner
 * that is still installing is not cut off by this deadline.
 */
const HARNESS_INSTALL_DEADLINE: Duration.Duration = Duration.minutes(6);

const InstallInput = Schema.Struct({ runnerId: Id, harnessId: Schema.String });

type InstallInput = Schema.Schema.Type<typeof InstallInput>;

const decodeInstall = Schema.decodeUnknownEffect(InstallInput);

type InstallError =
  | Unauthenticated
  | Forbidden
  | SqlError
  | Schema.SchemaError
  | Validation
  | NotFound
  | InvalidState;

const make = Effect.gen(function* () {
  const runners = yield* runnerRepository;
  const connections = yield* RunnerConnections;
  const host = yield* PluginHost;
  const probing = yield* ProviderAccountProbing;
  const readRunner = readRunnerOrFail(runners);

  /**
   * Checks that the harness can be installed on the runner. Fails with
   * `Validation` when no plugin registered the harness (the message lists the
   * registered ids, so a caller who wrote a bare name such as `codex` sees the
   * qualified one to use), and otherwise as `requireAdapter` does: the runner
   * must be online and its build must carry the harness's adapter.
   */
  const requireInstallTarget = (
    runnerId: string,
    harnessId: string,
  ): Effect.Effect<void, NotFound | SqlError | Validation | InvalidState> =>
    Effect.gen(function* () {
      const registered = yield* host.harnesses();
      if (!registered.some((candidate) => candidate.id === harnessId)) {
        return yield* Effect.fail(
          createValidationError([
            {
              path: ["harnessId"],
              message: `no plugin registered the harness ${harnessId}; the registered harnesses are ${registered.map((candidate) => candidate.id).join(", ")}`,
            },
          ]),
        );
      }
      yield* requireAdapter(yield* readRunner(runnerId), harnessId, "harnessId");
    });

  return {
    /**
     * Installs a harness on a runner, and returns the runner. The runner
     * reports its facts before it reports that the install finished, so the
     * returned runner is up to date.
     *
     * After a successful install, probes the runner's accounts without
     * waiting. A first install changes the runner's harnesses, which sweeps
     * the runner by itself (see `harnessesChanged` in `Inbound`), but an
     * update installs a new version at the same path and changes nothing the
     * facts report shows, so only this sweep refreshes the version the
     * snapshots hold.
     */
    installHarness: (input: InstallInput): Effect.Effect<RunnerDetail, InstallError> =>
      Effect.gen(function* () {
        yield* requireGrant("runner.installHarness");
        const { runnerId, harnessId } = yield* Effect.mapError(
          decodeInstall(input),
          createDecodeValidationError,
        );
        yield* requireInstallTarget(runnerId, harnessId);
        const answer = yield* connections.asked(
          runnerId,
          { _tag: "installRequest", requestId: crypto.randomUUID(), harnessId },
          HARNESS_INSTALL_DEADLINE,
        );
        if (Option.isNone(answer) || answer.value._tag !== "installResult") {
          const waited = Duration.format(HARNESS_INSTALL_DEADLINE);
          return yield* Effect.fail(
            createInvalidStateError(`that runner did not finish the install within ${waited}`),
          );
        }
        if (!answer.value.ok) {
          return yield* Effect.fail(
            createInvalidStateError(answer.value.message ?? "the install failed"),
          );
        }
        yield* Effect.forkDetach(probing.sweepRunner(runnerId));
        return yield* readRunner(runnerId);
      }),
  };
});

export class HarnessInstall extends Context.Service<HarnessInstall, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/HarnessInstall",
) {}

export const HarnessInstallLayer: Layer.Layer<
  HarnessInstall,
  never,
  SqlClient.SqlClient | RunnerConnections | PluginHost | ProviderAccountProbing
> = Layer.effect(HarnessInstall)(make);
