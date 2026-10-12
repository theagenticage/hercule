/**
 * The Ignore Rule operations: `ignoreRule.query`, `create` and `delete`
 * (spec 10 §9.9).
 *
 * An Ignore Rule keeps signals of one plugin kind, with given match values,
 * from being raised. A rule hides things from the user, so only the user
 * creates or deletes one. The only answer that creates one is Ignore on the
 * core's own offer, because `signal.raise` refuses any other action that
 * binds `ignoreRule.create`. Creating a rule also resolves the open signals
 * it matches, and the open offer of the same rule, in the same transaction.
 * Deleting one brings nothing back.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  buildIgnoreRuleText,
  createConflictError,
  createNotFoundError,
  createValidationError,
  hasSameValues,
  IGNORE_ACTION_ID,
  isCoreSignalKind,
  isMatchedByRule,
  type Conflict,
  type Forbidden,
  type IgnoreRule,
  type IgnoreRuleCreateInput,
  type IgnoreRuleFilter,
  type IgnoreRuleWithCatches,
  type NotFound,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { buildActorStamp, buildResolutionOrigin, requireActor, requireUserActor } from "../actor";
import { mintUuid, nowIso, uuidToString, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PluginHost } from "../plugins";
import { ignoreRuleRepository } from "./ignore-rule-repository";
import { SignalClaims } from "./claims";
import { buildIgnoredOutcome } from "./outcome";
import { signalRepository } from "./repository";

/**
 * The refusal of `create` and `delete` for a caller who is not the user. A
 * rule hides signals from the user, so an agent may not make one for them.
 */
const ONLY_THE_USER_IGNORES =
  "only the user may create or delete an Ignore Rule, because a rule hides signals from them; to suggest a rule, describe it to the user in a signal, and the user creates it from Intake";

/** Builds the `Validation` error for the `kind` of a new rule. */
const buildKindRefusal = (message: string): Validation =>
  createValidationError([{ path: ["kind"], message }]);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rules = yield* ignoreRuleRepository;
  const signals = yield* signalRepository;
  const audit = yield* AuditLog;
  const host = yield* PluginHost;
  const claims = yield* SignalClaims;

  return {
    /**
     * Returns the rules, of one kind when the filter names one, oldest
     * first, each with the number of events it caught that are still in the
     * log and when it caught the last one.
     */
    query: (
      filter: IgnoreRuleFilter,
    ): Effect.Effect<
      ReadonlyArray<IgnoreRuleWithCatches>,
      Unauthenticated | Forbidden | SqlError
    > => Effect.andThen(requireActor("ignoreRule.query"), rules.listWithCatches(filter.kind)),

    /**
     * Creates a rule and returns it. Its text is written from the kind's
     * labels. In the same transaction, it resolves with the
     * outcome "Ignored · rule <text>":
     *
     * - the open signals of its kind that it matches;
     * - the core's open offer of the same rule, which has nothing left to
     *   ask once the user made the rule another way.
     *
     * A signal an action, a withdrawal or Done is working on right now stays
     * open: its claim is held, and the work that holds it resolves it. Taking
     * Ignore on the offer is such work, because it runs this operation while
     * it holds the claim on the offer and then resolves the offer itself.
     *
     * Fails with:
     *
     * - `Forbidden` when the caller is not the user;
     * - `Validation` when the kind is a core kind or no loaded plugin
     *   declares it, or when a value names a field the kind does not
     *   declare. A rule with no values never reaches here: the contract
     *   refuses it;
     * - `Conflict` when a rule of the kind with the same values exists. The
     *   message names that rule's id.
     */
    create: (
      input: IgnoreRuleCreateInput,
    ): Effect.Effect<IgnoreRule, Unauthenticated | Forbidden | Validation | Conflict | SqlError> =>
      Effect.gen(function* () {
        const caller = yield* requireUserActor("ignoreRule.create", ONLY_THE_USER_IGNORES);
        if (isCoreSignalKind(input.kind)) {
          return yield* Effect.fail(
            buildKindRefusal(
              `${input.kind} is a core kind. An Ignore Rule stops signals of a plugin's kind only, such as github/review-requested.`,
            ),
          );
        }
        const kind = yield* host.findSignalKind(input.kind);
        if (Option.isNone(kind)) {
          return yield* Effect.fail(
            buildKindRefusal(
              `No plugin declares the signal kind ${input.kind}. Write a kind as <plugin>/<word>, such as github/review-requested, and check that its plugin is installed.`,
            ),
          );
        }
        const declared = kind.value.matchFields.map((field) => field.name);
        const unknown = Object.keys(input.match).filter((name) => !declared.includes(name));
        if (unknown.length > 0) {
          return yield* Effect.fail(
            createValidationError(
              unknown.map((name) => ({
                path: ["match", name],
                message: `The kind ${input.kind} has no match field ${name}. Match on ${declared.length === 0 ? "nothing: the kind declares no match fields" : `one of: ${declared.join(", ")}`}.`,
              })),
            ),
          );
        }

        const actor = buildActorStamp(caller);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const existing = (yield* rules.list(input.kind)).find((rule) =>
              hasSameValues(rule.match, input.match),
            );
            if (existing !== undefined) {
              return yield* Effect.fail(
                createConflictError(
                  `The Ignore Rule ${existing.id} already ignores these signals: ${existing.text}.`,
                ),
              );
            }
            const at = yield* nowIso;
            const rule: IgnoreRule = {
              id: uuidToString(mintUuid()),
              kind: input.kind,
              match: input.match,
              text: buildIgnoreRuleText(kind.value, input.match),
              createdAt: at,
              actor,
            };
            yield* rules.insert(rule);
            const matched = (yield* signals.listOpenMatches(input.kind)).filter((signal) =>
              isMatchedByRule(signal.match, input.match),
            );
            const offers = (yield* signals.listIgnoreRuleOffers(input.kind)).filter(
              (offer) =>
                offer.status === "open" && hasSameValues(offer.ignoreRule.match, input.match),
            );
            // A claimed signal is left for the action that holds the claim.
            // A claim taken after this check is safe too: whoever takes a
            // claim reads the signal afterwards, and that read waits for
            // this transaction on the one database connection, so it finds
            // the signal resolved.
            const resolved = yield* signals.resolveMany(
              [...matched, ...offers]
                .map((signal) => signal.id)
                .filter((id) => !claims.isClaimed(id)),
              {
                kind: "decided",
                actionId: IGNORE_ACTION_ID,
                outcome: buildIgnoredOutcome(rule.text),
                actor,
                origin: buildResolutionOrigin(caller),
                at,
              },
            );
            yield* audit.append({
              kind: "ignoreRule.created",
              actor,
              record: { topic: "signal", ids: [...resolved] },
              payload: {
                ruleId: rule.id,
                kind: rule.kind,
                match: rule.match,
                text: rule.text,
                signalIds: [...resolved],
              },
              at,
            });
            return rule;
          }),
        );
      }),

    /**
     * Deletes a rule. The events it caught stay caught, and the signals it
     * resolved stay resolved. Fails with `Forbidden` when the caller is not
     * the user, and with `NotFound` when no rule has that id.
     */
    delete: (
      id: string,
    ): Effect.Effect<Record<string, never>, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        const caller = yield* requireUserActor("ignoreRule.delete", ONLY_THE_USER_IGNORES);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const deleted = yield* rules.delete(id);
            if (Option.isNone(deleted)) {
              return yield* Effect.fail(
                createNotFoundError(
                  `No Ignore Rule has the id ${id}. List the rules with hercule ignore-rule list.`,
                ),
              );
            }
            const { kind, match, text } = deleted.value;
            yield* audit.append({
              kind: "ignoreRule.deleted",
              actor: buildActorStamp(caller),
              payload: { ruleId: id, kind, match, text },
            });
            return {};
          }),
        );
      }),
  };
});

/** The Ignore Rule service. */
export class IgnoreRuleService extends Context.Service<
  IgnoreRuleService,
  Effect.Success<typeof make>
>()("hercule/controller/signals/IgnoreRuleService") {}

export const IgnoreRuleServiceLayer: Layer.Layer<
  IgnoreRuleService,
  never,
  SqlClient.SqlClient | AuditLog | PluginHost | SignalClaims
> = Layer.effect(IgnoreRuleService)(make);
