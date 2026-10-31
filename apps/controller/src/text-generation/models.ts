/**
 * Works out which provider instance and model text generations run on now,
 * from the `textGeneration.model` setting, and which runners could make the
 * call there.
 *
 * - `off`: nothing runs.
 * - A chosen instance and model: exactly that. It is never replaced by
 *   another harness, so a user who chose Codex never has a call quietly go
 *   to Claude.
 * - `automatic` (the default when the setting is unset): the first harness in
 *   `AUTOMATIC_HARNESS_ORDER` that has an instance logged in on a runner
 *   that could make the call, whose model list there holds the harness's
 *   suggested text generation model. Choosing the model is visible, not
 *   hidden: Settings shows what `automatic` resolves to.
 *
 * A runner could make the call when it is placeable (online, active, not
 * reserved), has negotiated the text generation capability, has the instance
 * logged in, and lists the model for that instance. Resolution and the
 * runner choice share this one rule, so `automatic` never picks a model that
 * no runner can run.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { TEXT_GENERATION_CAPABILITY } from "@hercule/protocol";
import { PluginHost } from "../plugins";
import {
  isLoggedIn,
  providerRepository,
  type StoredInstance,
  type StoredSnapshot,
} from "../providers";
import { runnerRepository, type PlacementCandidate } from "../runners";
import { Settings } from "../settings";

/**
 * The providers `automatic` tries, best first. The order is a decision of the
 * controller, not of a harness, so a plugin cannot move itself to the front.
 * Each harness names its own suggested model on its definition.
 */
const AUTOMATIC_HARNESS_ORDER: ReadonlyArray<string> = ["codex", "pi", "claude-code"];

/**
 * What the setting resolves to now:
 *
 * - `off`: text generation is switched off.
 * - `resolved`: calls run on this instance and model. `runnerIds` lists the
 *   runners that could make the call, in no particular order. It is empty
 *   when a chosen model is offered by no such runner.
 * - `unresolved`: no model can be used, and `message` explains why in words a
 *   user can act on. For example `automatic` found no match.
 *
 * Every variant carries `failureKey`, which names the setting value and what
 * it resolved to. The last failure is stored under it and shown only under
 * the same key. So a failure is hidden when the user chooses another model,
 * and also when `automatic` starts resolving to another instance or model.
 */
export type TextGenerationTarget = { readonly failureKey: string } & TextGenerationChoice;

/** What a value of the setting resolves to, before it is tied to that value. */
type TextGenerationChoice =
  | { readonly _tag: "off" }
  | {
      readonly _tag: "resolved";
      readonly instance: StoredInstance;
      readonly model: string;
      readonly runnerIds: ReadonlyArray<string>;
    }
  | { readonly _tag: "unresolved"; readonly message: string };

const NO_AUTOMATIC_MATCH = "no up-to-date runner is logged in to a suggested model";

const CHOSEN_INSTANCE_GONE = "the provider instance chosen for text generation no longer exists";

const TEXT_GENERATION_OFF_REASON = "text generation is off in Settings";

/**
 * Returns why no text generation can run on the target, as one short clause
 * a user can act on. The reason is:
 *
 * - for `off`: that text generation is switched off in Settings;
 * - for `unresolved`: the target's own message;
 * - for `resolved`: that no runner able to take the call is logged in to the
 *   instance with the model. So call it for a resolved target only when its
 *   `runnerIds` is empty.
 */
export const explainTextGenerationUnavailable = (target: TextGenerationTarget): string => {
  switch (target._tag) {
    case "off":
      return TEXT_GENERATION_OFF_REASON;
    case "unresolved":
      return target.message;
    case "resolved":
      return `no up-to-date runner is logged in to the provider instance ${target.instance.name} with the model ${target.model}`;
  }
};

/**
 * Returns why no text generation can run on the target now, or null when a
 * runner could take a call: the target resolves and at least one runner
 * offers its model. Otherwise returns `explainTextGenerationUnavailable`.
 *
 * The status in `controller.read`, the run engine's check before a text
 * generation step calls, and the error of a call that could not be placed
 * all use this one rule, so they never disagree.
 */
export const buildTextGenerationUnavailableReason = (
  target: TextGenerationTarget,
): string | null =>
  target._tag === "resolved" && target.runnerIds.length > 0
    ? null
    : explainTextGenerationUnavailable(target);

/**
 * Checks whether a runner can be asked for a text generation at all: it is
 * placeable (online, active, not reserved) and negotiated the text generation
 * capability at its last hello.
 */
const canTakeTextGeneration = (candidate: PlacementCandidate): boolean =>
  candidate.placeable && candidate.capabilities.includes(TEXT_GENERATION_CAPABILITY);

/**
 * Lists the runners among `capable` whose stored snapshot of the instance
 * shows it logged in and listing `model`. Never probes a runner.
 */
const listRunnersOffering = (
  capable: ReadonlySet<string>,
  snapshots: ReadonlyArray<StoredSnapshot>,
  instanceId: string,
  model: string,
): ReadonlyArray<string> =>
  snapshots
    .filter(
      (snapshot) =>
        snapshot.instanceId === instanceId &&
        capable.has(snapshot.runnerId) &&
        isLoggedIn(snapshot) &&
        snapshot.models.some((one) => one.slug === model),
    )
    .map((snapshot) => snapshot.runnerId);

const make = Effect.gen(function* () {
  const settings = yield* Settings;
  const instances = yield* providerRepository;
  const runners = yield* runnerRepository;
  const host = yield* PluginHost;

  /** Reads the ids of the runners that can be asked for a text generation. */
  const readCapableRunnerIds = Effect.map(
    runners.listPlacementCandidates(),
    (candidates) => new Set(candidates.filter(canTakeTextGeneration).map((one) => one.id)),
  );

  /**
   * Finds the first instance, in provider order, that a runner able to make
   * the call has logged in with its provider's suggested model.
   */
  const resolveAutomatic: Effect.Effect<TextGenerationChoice, SqlError> = Effect.gen(function* () {
    const capable = yield* readCapableRunnerIds;
    const definitions = yield* host.providers();
    const all = yield* instances.list();
    const snapshots = yield* instances.snapshots();
    for (const harnessId of AUTOMATIC_HARNESS_ORDER) {
      const model = definitions.find((one) => one.id === harnessId)?.suggestedTextGenerationModel;
      if (model === undefined) continue;
      for (const instance of all.filter((one) => one.harnessId === harnessId)) {
        const runnerIds = listRunnersOffering(capable, snapshots, instance.id, model);
        if (runnerIds.length > 0) return { _tag: "resolved", instance, model, runnerIds } as const;
      }
    }
    return { _tag: "unresolved", message: NO_AUTOMATIC_MATCH } as const;
  }).pipe(
    // A stored row that no longer decodes is corruption, not a state the
    // caller can act on.
    Effect.catchTag("SchemaError", Effect.die),
  );

  return {
    /**
     * Resolves the setting to what text generations run on now. A resolved
     * target carries the instance row and the runners that could make the
     * call, so the caller does not read them again. Reads the stored
     * snapshots and never probes a runner, so a login that expired since the
     * last probe still resolves; the call then fails with an explanation.
     * Fails only when the database cannot be read.
     */
    resolve: (): Effect.Effect<TextGenerationTarget, SqlError> =>
      Effect.gen(function* () {
        const setting = (yield* settings.all())["textGeneration.model"] ?? "automatic";
        const choice: TextGenerationChoice = yield* Effect.gen(function* () {
          if (setting === "off") return { _tag: "off" } as const;
          if (setting === "automatic") return yield* resolveAutomatic;
          const found = yield* Effect.catchTag(
            instances.one(setting.instanceId),
            "SchemaError",
            Effect.die,
          );
          if (Option.isNone(found)) {
            return { _tag: "unresolved", message: CHOSEN_INSTANCE_GONE } as const;
          }
          const capable = yield* readCapableRunnerIds;
          const snapshots = yield* Effect.catchTag(
            instances.listSnapshots(found.value.id),
            "SchemaError",
            Effect.die,
          );
          return {
            _tag: "resolved",
            instance: found.value,
            model: setting.model,
            runnerIds: listRunnersOffering(capable, snapshots, found.value.id, setting.model),
          } as const;
        });
        const ran =
          choice._tag === "resolved"
            ? { instanceId: choice.instance.id, model: choice.model }
            : null;
        return { ...choice, failureKey: JSON.stringify({ setting, ran }) };
      }),
  };
});

/** The text generation model, as the setting resolves it. */
export class TextGenerationModels extends Context.Service<
  TextGenerationModels,
  Effect.Success<typeof make>
>()("hercule/controller/text-generation/TextGenerationModels") {}

export const TextGenerationModelsLayer: Layer.Layer<
  TextGenerationModels,
  never,
  SqlClient.SqlClient | Settings | PluginHost
> = Layer.effect(TextGenerationModels)(make);
