/**
 * How the apps present an Ignore Rule's row in Settings > Signals: what the
 * rule caught, and which rules belong to a plugin's section. Spec 10 §9.9
 * owns the rule and what it does; spec 17 §Settings owns where the apps show it.
 */
import type { IgnoreRuleWithCatches } from "@hercule/contract";
import { parsePluginId } from "./plugin-id";

/** How many days the controller keeps events when the `retention.events` setting is not set. */
const DEFAULT_EVENT_RETENTION_DAYS = 90;

/**
 * Names the span the `retention.events` setting keeps: "the last 90 days", or
 * "the last day" for one. A setting that is not set reads as the default of
 * 90 days.
 */
const describeRetentionSpan = (retentionDays: number | undefined): string => {
  const days = retentionDays ?? DEFAULT_EVENT_RETENTION_DAYS;
  return days === 1 ? "the last day" : `the last ${String(days)} days`;
};

/**
 * Returns the hint under a rule's row in Settings > Signals, which counts what
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
 * in the order of `rules`. Settings > Signals lists them in the plugin's
 * section.
 */
export const listPluginIgnoreRules = (
  rules: ReadonlyArray<IgnoreRuleWithCatches>,
  pluginId: string,
): ReadonlyArray<IgnoreRuleWithCatches> =>
  rules.filter((rule) => parsePluginId(rule.kind) === pluginId);
