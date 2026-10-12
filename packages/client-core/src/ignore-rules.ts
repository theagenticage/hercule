/**
 * How the apps present Ignore Rules: Hercule's offer of a rule, the open
 * signals a rule would take off the list, the Ignore dialog's fields and
 * lines, and a rule's row in Settings > Intake. Spec 10 §9.9 owns the rule and what it
 * does; spec 17 §Intake and §Settings own where the apps show it.
 */
import {
  isMatchedByRule,
  MAX_SIGNAL_MATCH_VALUE_LENGTH,
  readMatchValue,
  type IgnoreRuleCreateInput,
  type IgnoreRuleWithCatches,
  type PluginDetail,
  type Signal,
  type SignalKindLabels,
  type SignalMatch,
} from "@hercule/contract";
import { describeRetentionSpan, lowerFirst } from "./intake";
import { parsePluginId } from "./plugin-id";

/**
 * Checks whether `signal` is Hercule's offer of an Ignore Rule: an `offer`
 * that carries the rule its Ignore answer creates. Triage raises offers too,
 * and those carry no rule.
 */
export const isIgnoreRuleOffer = (
  signal: Signal,
): signal is Signal & { readonly ignoreRule: IgnoreRuleCreateInput } =>
  signal.kind === "offer" && signal.ignoreRule !== undefined;

/**
 * Returns the open signals in `signals` that the rule `rule` matches: those
 * of its kind whose match values hold every value of the rule. These are
 * what creating the rule takes off the list, snoozed signals included.
 *
 * The result is only as complete as `signals`. A caller passes every open
 * signal of the kind it holds, To do and every page of Later, so the result
 * is never cut short by a page. A signal listed twice is returned once.
 */
export const listSignalsMatchedByRule = (
  signals: ReadonlyArray<Signal>,
  rule: IgnoreRuleCreateInput,
): ReadonlyArray<Signal> => {
  const matched = new Map<string, Signal>();
  for (const signal of signals) {
    if (
      signal.status === "open" &&
      signal.kind === rule.kind &&
      isMatchedByRule(signal.match, rule.match)
    )
      matched.set(signal.id, signal);
  }
  return [...matched.values()];
};

/**
 * Returns the labels the plugin of the signal kind `kind` declares for the
 * kind and its match fields, as `plugins` lists them. The backend writes a
 * rule's text and Hercule's offer from the same labels, so the apps name a
 * rule's values the same way.
 *
 * When no plugin in `plugins` declares the kind, such as when its plugin was
 * removed while the signal is open, the kind is labelled with its own id and
 * no match field is declared.
 */
export const readSignalKindLabels = (
  plugins: ReadonlyArray<Pick<PluginDetail, "intake">>,
  kind: string,
): SignalKindLabels => {
  for (const plugin of plugins) {
    const setting = plugin.intake.signalKinds.find((each) => each.kind === kind);
    if (setting !== undefined) return setting;
  }
  return { label: kind, matchFields: [] };
};

/**
 * Returns each match field the kind declares, as `labels` lists them, that
 * `match` holds a value for: its name, its label and the value. The fields
 * keep the order the plugin declares them in.
 *
 * Two kinds of value are left out, because `ignoreRule.create` refuses a rule
 * that holds them:
 *
 * - a value for a field the kind no longer declares, because a plugin update
 *   removed it or the plugin is gone;
 * - a value longer than `MAX_SIGNAL_MATCH_VALUE_LENGTH`, which only a signal
 *   stored before that limit existed can hold.
 */
export const listDeclaredMatchValues = (
  labels: SignalKindLabels,
  match: SignalMatch,
): ReadonlyArray<{ readonly field: string; readonly label: string; readonly value: string }> =>
  labels.matchFields.flatMap(({ name, label }) => {
    const value = readMatchValue(match, name);
    return value === undefined || value.length > MAX_SIGNAL_MATCH_VALUE_LENGTH
      ? []
      : [{ field: name, label, value }];
  });

/**
 * Checks whether the user can build an Ignore Rule from `signal`, whose kind
 * is labelled by `labels`: the kind must declare at least one match field
 * that the signal holds a value for, because a rule needs one value. Core
 * kinds, such as an offer, declare no match field, so they never qualify.
 */
export const canIgnoreSignal = (signal: Pick<Signal, "match">, labels: SignalKindLabels): boolean =>
  listDeclaredMatchValues(labels, signal.match).length > 0;

/**
 * Returns the line of Hercule's offer that counts the open signals its rule
 * matches: "3 open now", or "None open now".
 */
export const describeOfferedRuleMatchCount = (count: number): string =>
  count === 0 ? "None open now" : `${String(count)} open now`;

/**
 * Returns the Ignore dialog's first line, which says what creating the rule
 * does, for the kind labelled `kindLabel`: "From now on, Hercule ignores
 * review requested signals that have every checked value."
 */
export const describeIgnoreDialogEffect = (kindLabel: string): string =>
  `From now on, Hercule ignores ${lowerFirst(kindLabel)} signals that have every checked value.`;

/**
 * Returns the Ignore dialog's line about the open signals the rule takes off
 * the list when it is created. `count` is how many it matches, or where the
 * count stands while it cannot be given:
 *
 * - a number: "This also takes 3 open signals off your list.", "1 open
 *   signal" for one, and "No open signal matches it now." at 0;
 * - `"reading"`: the open signals are still being read;
 * - `"failed"`: they could not be read.
 *
 * The line never shows a number before every open signal is read, so the
 * count is never short.
 */
export const describeRuleMatchesTakenOff = (count: number | "reading" | "failed"): string => {
  if (count === "reading") return "Counting the open signals it matches…";
  if (count === "failed") return "Could not count the open signals it matches.";
  if (count === 0) return "No open signal matches it now.";
  return `This also takes ${String(count)} open ${count === 1 ? "signal" : "signals"} off your list.`;
};

/**
 * Why the Ignore dialog's last checked value cannot be unchecked, shown when
 * the user points at it or focuses it.
 */
export const LAST_MATCH_VALUE_REASON =
  "A rule needs at least one value, so this one stays checked.";

/**
 * The Ignore dialog's last line, for a user who wants none of the kind:
 * "To stop every signal of this kind, switch the kind off." Only `link` is
 * the link to the kind's row in Settings > Intake; `lead` and `end` are the
 * plain text around it.
 */
export const KIND_SWITCH_OFF_LINE = {
  lead: "To stop every signal of this kind, ",
  link: "switch the kind off",
  end: ".",
} as const;

/**
 * Returns the hint under a rule's row in Settings > Intake, which counts what
 * the rule caught: "Caught 142 in the last 90 days". A catch is pruned with
 * its event, so the count covers the span the `retention.events` setting
 * keeps, `retentionDays`, which reads as the default of 90 days when it is
 * not set.
 */
export const describeIgnoreRuleCatches = (
  caughtCount: number,
  retentionDays: number | undefined,
): string => `Caught ${String(caughtCount)} in ${describeRetentionSpan(retentionDays)}`;

/**
 * Returns the rules in `rules` whose kind belongs to the plugin `pluginId`,
 * in the order of `rules`. Settings > Intake lists them in the plugin's
 * section.
 */
export const listPluginIgnoreRules = (
  rules: ReadonlyArray<IgnoreRuleWithCatches>,
  pluginId: string,
): ReadonlyArray<IgnoreRuleWithCatches> =>
  rules.filter((rule) => parsePluginId(rule.kind) === pluginId);
