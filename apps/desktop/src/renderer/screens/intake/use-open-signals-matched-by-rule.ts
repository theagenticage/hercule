import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { IgnoreRuleCreateInput, Signal } from "@hercule/contract";
import { listSignalsMatchedByRule } from "@hercule/client-core";
import { laterSignalsOfKindQuery, signalsToDoQuery } from "../../app/queries";

/** The open signals an Ignore Rule matches, as far as the reads have answered. */
export type OpenSignalsMatchedByRule =
  | { readonly state: "reading" }
  | { readonly state: "failed" }
  | { readonly state: "read"; readonly signals: ReadonlyArray<Signal> };

/**
 * Returns the open signals the rule `rule` matches, which creating it takes
 * off the list. They are looked for in To do, which the shell holds whole
 * and keeps live, and in every page of Later of the rule's kind.
 *
 * Later is read once, when the caller mounts, and is not read again while
 * it stays mounted, so a signal snoozed in the meantime is counted only by
 * the next opening. The state is `reading` until both reads answer, and
 * `failed` when either fails with nothing read before, so a caller never
 * shows a count that is short.
 */
export const useOpenSignalsMatchedByRule = (
  rule: IgnoreRuleCreateInput,
): OpenSignalsMatchedByRule => {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const toDo = useQuery(signalsToDoQuery(client));
  const later = useQuery(laterSignalsOfKindQuery(client, rule.kind));
  if (toDo.data !== undefined && later.data !== undefined) {
    return {
      state: "read",
      signals: listSignalsMatchedByRule([...toDo.data, ...later.data], rule),
    };
  }
  return toDo.isError || later.isError ? { state: "failed" } : { state: "reading" };
};
