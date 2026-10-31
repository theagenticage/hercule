/**
 * Works out which Provider Account, harness and model text generations run on
 * now, from the `textGeneration.model` setting, and which runners could make
 * the call there.
 *
 * - `off`: nothing runs.
 * - A chosen account and model: exactly that, in the chosen harness or else
 *   the account's default harness. It is never replaced by another account
 *   or harness, so a user who chose OpenAI never has a call quietly go to
 *   Anthropic.
 * - `automatic` (the default when the setting is unset): the first provider
 *   in `AUTOMATIC_PROVIDER_ORDER` that has an account signed in, in its
 *   default harness, on a runner that could make the call, and whose model
 *   list there holds the provider's suggested text generation model. The
 *   oldest such account of the provider is taken. Choosing the model is
 *   visible, not hidden: Settings shows what `automatic` resolves to.
 *
 * A runner could make the call when it is placeable (online, active, not
 * reserved), has negotiated the text generation capability, has the account
 * signed in in the harness, and lists the model for that pair. Resolution and
 * the runner choice share this one rule, so `automatic` never picks a model
 * that no runner can run.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { Validation } from "@hercule/contract";
import { TEXT_GENERATION_CAPABILITY } from "@hercule/protocol";
import { PluginHost } from "../plugins";
import {
  describeAccount,
  isLoggedIn,
  providerAccountRepository,
  resolveAccountHarness,
  type StoredProviderAccount,
  type StoredSnapshot,
} from "../provider-accounts";
import { runnerRepository, type PlacementCandidate } from "../runners";
import { Settings } from "../settings";

/**
 * The providers `automatic` tries, best first, by qualified id: OpenAI, then
 * Z.ai, then Anthropic.
 *
 * TEMPORARY: this fixed order keeps what `automatic` did when Codex, pi and
 * Claude Code were the harnesses it tried. Ticket #934 replaces it with the
 * order the accounts were added in. The order is a decision of the
 * controller, not of a provider, so a plugin cannot move itself to the front.
 */
const AUTOMATIC_PROVIDER_ORDER: ReadonlyArray<string> = [
  "openai/openai",
  "zai/zai",
  "anthropic/anthropic",
];

/**
 * What the setting resolves to now:
 *
 * - `off`: text generation is switched off.
 * - `resolved`: calls run on this account, harness and model. `runnerIds`
 *   lists the runners that could make the call, in no particular order. It is
 *   empty when a chosen model is offered by no such runner. `accountName` is
 *   how a message names the account, such as "Anthropic · work".
 * - `unresolved`: no model can be used, and `message` explains why in words a
 *   user can act on. For example `automatic` found no match.
 *
 * Every variant carries `failureKey`, which names the setting value and what
 * it resolved to. The last failure is stored under it and shown only under
 * the same key. So a failure is hidden when the user chooses another model,
 * and also when `automatic` starts resolving to another account, harness or
 * model.
 */
export type TextGenerationTarget = { readonly failureKey: string } & TextGenerationChoice;

/** What a value of the setting resolves to, before it is tied to that value. */
type TextGenerationChoice =
  | { readonly _tag: "off" }
  | {
      readonly _tag: "resolved";
      readonly providerAccountId: string;
      readonly accountName: string;
      readonly harnessId: string;
      readonly model: string;
      readonly runnerIds: ReadonlyArray<string>;
    }
  | { readonly _tag: "unresolved"; readonly message: string };

const NO_AUTOMATIC_MATCH =
  "no up-to-date runner has an account signed in that offers a suggested text generation model";

const CHOSEN_ACCOUNT_GONE =
  "the provider account chosen for text generation was deleted; choose another in Settings";

const TEXT_GENERATION_OFF_REASON = "text generation is off in Settings";

/**
 * Returns why no text generation can run on the target, as one short clause
 * a user can act on. The reason is:
 *
 * - for `off`: that text generation is switched off in Settings;
 * - for `unresolved`: the target's own message;
 * - for `resolved`: that no runner able to take the call has the account
 *   signed in with the model. So call it for a resolved target only when its
 *   `runnerIds` is empty.
 */
export const explainTextGenerationUnavailable = (target: TextGenerationTarget): string => {
  switch (target._tag) {
    case "off":
      return TEXT_GENERATION_OFF_REASON;
    case "unresolved":
      return target.message;
    case "resolved":
      return `no up-to-date runner has ${target.accountName} signed in with the model ${target.model}`;
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
 * Lists the runners among `capable` whose stored snapshot of the account in
 * the harness shows it signed in and listing `model`. Never probes a runner.
 * `snapshots` are the account's snapshots in that harness.
 */
const listRunnersOffering = (
  capable: ReadonlySet<string>,
  snapshots: ReadonlyArray<StoredSnapshot>,
  model: string,
): ReadonlyArray<string> =>
  snapshots
    .filter(
      (snapshot) =>
        capable.has(snapshot.runnerId) &&
        isLoggedIn(snapshot) &&
        snapshot.models.some((one) => one.slug === model),
    )
    .map((snapshot) => snapshot.runnerId);

const make = Effect.gen(function* () {
  const settings = yield* Settings;
  const accounts = yield* providerAccountRepository;
  const runners = yield* runnerRepository;
  const host = yield* PluginHost;
  // What `resolveAccountHarness` reads, captured here so the methods below
  // need nothing from their caller.
  const accountServices = yield* Effect.context<SqlClient.SqlClient | PluginHost>();

  /** Reads the ids of the runners that can be asked for a text generation. */
  const readCapableRunnerIds = Effect.map(
    runners.listPlacementCandidates(),
    (candidates) => new Set(candidates.filter(canTakeTextGeneration).map((one) => one.id)),
  );

  /**
   * Resolves one account in one harness (the account's default when
   * `harnessId` is absent) and a model to a target. An account that cannot
   * run in the harness is `unresolved`, with the reason in the message.
   */
  const resolveAccountModel = (
    account: StoredProviderAccount,
    harnessId: string | undefined,
    model: string,
  ): Effect.Effect<TextGenerationChoice, SqlError> =>
    Effect.gen(function* () {
      const providers = yield* host.providers();
      const accountName = describeAccount(account, providers);
      const resolved = yield* resolveAccountHarness(account.id, harnessId).pipe(
        Effect.provideContext(accountServices),
        // A stored row that no longer decodes is corruption, not a state the
        // caller can act on.
        Effect.catchTag("SchemaError", Effect.die),
        Effect.result,
      );
      if (resolved._tag === "Failure") {
        const error = resolved.failure;
        if (!(error instanceof Validation)) return yield* Effect.fail(error);
        const reason = error.error.details.issues[0]?.message ?? "it cannot run in that harness";
        return {
          _tag: "unresolved",
          message: `${accountName} cannot make text generations: ${reason}`,
        } as const;
      }
      return {
        _tag: "resolved",
        providerAccountId: account.id,
        accountName,
        harnessId: resolved.success.harnessId,
        model,
        runnerIds: listRunnersOffering(
          yield* readCapableRunnerIds,
          resolved.success.snapshots,
          model,
        ),
      } as const;
    });

  /**
   * Finds the first account, in provider order and then oldest first, that a
   * runner able to make the call has signed in, in its default harness, with
   * its provider's suggested model.
   */
  const resolveAutomatic: Effect.Effect<TextGenerationChoice, SqlError> = Effect.gen(function* () {
    const providers = yield* host.providers();
    const all = yield* accounts.list();
    for (const providerId of AUTOMATIC_PROVIDER_ORDER) {
      const model = providers.find((one) => one.id === providerId)?.suggestedTextGenerationModel;
      if (model === undefined) continue;
      for (const account of all.filter((one) => one.providerId === providerId)) {
        const choice = yield* resolveAccountModel(account, undefined, model);
        if (choice._tag === "resolved" && choice.runnerIds.length > 0) return choice;
      }
    }
    return { _tag: "unresolved", message: NO_AUTOMATIC_MATCH } as const;
  });

  return {
    /**
     * Resolves the setting to what text generations run on now. A resolved
     * target carries the account, the harness and the runners that could
     * make the call, so the caller does not read them again. Reads the
     * stored snapshots and never probes a runner, so a login that expired
     * since the last probe still resolves; the call then fails with an
     * explanation. Fails only when the database cannot be read.
     */
    resolve: (): Effect.Effect<TextGenerationTarget, SqlError> =>
      Effect.gen(function* () {
        const setting = (yield* settings.all())["textGeneration.model"] ?? "automatic";
        const choice: TextGenerationChoice = yield* Effect.gen(function* () {
          if (setting === "off") return { _tag: "off" } as const;
          if (setting === "automatic") return yield* resolveAutomatic;
          const chosen = yield* accounts.one(setting.providerAccountId);
          if (Option.isNone(chosen)) {
            return { _tag: "unresolved", message: CHOSEN_ACCOUNT_GONE } as const;
          }
          return yield* resolveAccountModel(chosen.value, setting.harnessId, setting.model);
        });
        const ran =
          choice._tag === "resolved"
            ? {
                providerAccountId: choice.providerAccountId,
                harnessId: choice.harnessId,
                model: choice.model,
              }
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
