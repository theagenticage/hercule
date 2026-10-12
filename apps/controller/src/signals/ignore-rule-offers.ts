/**
 * The core's Ignore Rule offer (spec 10 §9.9, "The core suggests rules").
 *
 * When the user marks the newest signals of one group done, one after the
 * other, without answering them, the core raises an `offer` signal asking
 * whether to ignore that group from now on. A group is the signals of one
 * plugin kind with exactly the same match values. `signal.markDone` calls
 * `offerIgnoreRules` in its transaction, so the offer commits with the Done
 * that earned it.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  describeMatchValue,
  hasSameValues,
  IGNORE_ACTION_ID,
  IgnoreRuleCreateInput,
  isCoreSignalKind,
  listLabeledValues,
  MAX_SIGNAL_TITLE_LENGTH,
  truncateText,
  type Signal,
  type SignalMatch,
} from "@hercule/contract";
import { SYSTEM_ACTOR } from "../actor";
import { mintUuid, uuidToString } from "../db";
import { AuditLog } from "../events";
import { PluginHost } from "../plugins";
import { checkSignalFits, DISMISS_ACTION } from "./actions";
import { ignoreRuleRepository } from "./ignore-rule-repository";
import { encodeSignalMatch, signalRepository } from "./repository";

/**
 * How many of a group's newest signals the user must have marked Done, one
 * after the other, before the core offers an Ignore Rule for the group.
 */
const IGNORE_RULE_OFFER_STREAK = 5;

/** What joins the offer's question to its reason in the title. */
const QUESTION_MARK = "? ";

/** What `truncateText` appends to a text it cuts. */
const CUT_MARK = "...";

const isIgnoreRuleCreateInput = Schema.is(IgnoreRuleCreateInput);

const make = Effect.gen(function* () {
  const signals = yield* signalRepository;
  const rules = yield* ignoreRuleRepository;
  const audit = yield* AuditLog;
  const host = yield* PluginHost;

  /**
   * Raises the core's Ignore Rule offer for one group, the signals of `kind`
   * with exactly the values `match`, when the user marked its last
   * `IGNORE_RULE_OFFER_STREAK` signals done without answering them.
   *
   * Raises nothing when:
   *
   * - the streak is shorter;
   * - an offer of the same rule exists, open or resolved. A dismissed offer
   *   is the user's "no", so the core never asks again;
   * - a rule with the same values exists;
   * - no loaded plugin declares the kind, because the offer's title needs
   *   the kind's labels;
   * - `ignoreRule.create` would refuse the rule, because the group holds a
   *   field the kind no longer declares, or values from before the limits a
   *   rule has. Leaving those values out would offer a broader rule than the
   *   group the user marked done, so no rule is offered;
   * - the offer does not fit the `Signal` schema, which the check of the rule
   *   above should rule out. A warning is logged then, and Done still
   *   succeeds.
   */
  const offerIgnoreRule = (
    kind: string,
    match: SignalMatch,
    at: string,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const streak = yield* signals.countDoneStreak(kind, match);
      if (streak < IGNORE_RULE_OFFER_STREAK) return;
      const offered = yield* signals.listIgnoreRuleOffers(kind);
      if (offered.some((offer) => hasSameValues(offer.ignoreRule.match, match))) return;
      if ((yield* rules.list(kind)).some((rule) => hasSameValues(rule.match, match))) return;
      const declared = yield* host.findSignalKind(kind);
      if (Option.isNone(declared)) return;
      const isDeclared = (name: string) =>
        declared.value.matchFields.some((field) => field.name === name);
      if (!Object.keys(match).every(isDeclared) || !isIgnoreRuleCreateInput({ kind, match })) {
        return;
      }

      const reason = `You marked the last ${streak} done without answering.`;
      const conditions = listLabeledValues(declared.value, match)
        .map(({ label, value }) => `${label} is ${describeMatchValue(value)}`)
        .join(" and ");
      // A match value may be far longer than a title, so the question is cut
      // and the reason after it is always kept whole.
      const question = truncateText(
        `Ignore ${declared.value.label} where ${conditions}`,
        MAX_SIGNAL_TITLE_LENGTH - reason.length - QUESTION_MARK.length - CUT_MARK.length,
      );
      const id = uuidToString(mintUuid());
      const candidate: Signal = {
        id,
        kind: "offer",
        origin: { type: "api", actor: SYSTEM_ACTOR, eventIds: [], reason },
        title: `${question}${QUESTION_MARK}${reason}`,
        priority: "normal",
        blocks: [],
        actions: [
          {
            id: IGNORE_ACTION_ID,
            label: "Ignore",
            primary: true,
            operation: { op: "ignoreRule.create", input: { kind, match } },
          },
          DISMISS_ACTION,
        ],
        match: {},
        ignoreRule: { kind, match },
        status: "open",
        createdAt: at,
      };
      const fits = yield* Effect.result(checkSignalFits(candidate));
      if (Result.isFailure(fits)) {
        return yield* Effect.logWarning(
          `the core did not offer an Ignore Rule for ${kind}: the offer does not fit the signal schema`,
          fits.failure.error.details.issues,
        );
      }
      yield* signals.insert(fits.success, []);
      yield* audit.append({
        kind: "signal.raised",
        actor: SYSTEM_ACTOR,
        record: { topic: "signal", id },
        payload: { signalId: id, kind: "offer" },
        at,
      });
    });

  return {
    /**
     * Offers an Ignore Rule for each group the signals belong to, as
     * `offerIgnoreRule` decides. `resolved` are the signals the user just
     * marked done, and `at` is when. A group is a plugin kind with exact
     * match values, so a signal of a core kind, or with no match values, is
     * in none. A group is checked once, however many of its signals are
     * given. Runs in the caller's transaction.
     */
    offerIgnoreRules: (
      resolved: ReadonlyArray<Signal>,
      at: string,
    ): Effect.Effect<void, SqlError> => {
      const groups = new Map<string, Signal>();
      for (const signal of resolved) {
        if (isCoreSignalKind(signal.kind) || Object.keys(signal.match).length === 0) continue;
        const key = `${signal.kind}\n${encodeSignalMatch(signal.match)}`;
        if (!groups.has(key)) groups.set(key, signal);
      }
      return Effect.forEach(
        groups.values(),
        (member) => offerIgnoreRule(member.kind, member.match, at),
        { discard: true },
      );
    },
  };
});

/** The core's Ignore Rule offers, for the signal service's `markDone`. */
export const ignoreRuleOffers = make;
