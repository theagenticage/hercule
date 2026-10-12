import { useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import { describeMatchValue, type Signal, type SignalMatch } from "@hercule/contract";
import {
  describeIgnoreDialogEffect,
  describeRuleMatchesTakenOff,
  KIND_SWITCH_OFF_LINE,
  LAST_MATCH_VALUE_REASON,
  listDeclaredMatchValues,
  queryKeys,
  readErrorMessage,
  readSignalKindLabels,
} from "@hercule/client-core";
import { pluginsQuery } from "../../app/queries";
import { CheckIcon } from "../../icons/check";
import { ConfirmDialog } from "../confirm-dialog";
import { useOpenSignalsMatchedByRule } from "./use-open-signals-matched-by-rule";
import { useIntakeMoves } from "./use-signal-moves";

/**
 * Renders the Ignore dialog for the signal `signal` (spec 17 §The pane), and
 * creates the Ignore Rule the user builds in it:
 *
 * - one checkbox per match field the kind declares and the signal holds a
 *   value for that a rule can hold (`listDeclaredMatchValues` says which),
 *   in the order the plugin declares them, with the field's label
 *   and the value, all checked when the dialog opens. The last checked box
 *   cannot be unchecked, because a rule needs at least one value; pointing
 *   at it or focusing it says so;
 * - how many open signals the rule also takes off the list, counted again
 *   on every change of the boxes;
 * - a link to the kind's row in Settings > Intake, for a user who wants none
 *   of the kind.
 *
 * Create has the focus, because it only adds a rule. Once the rule is
 * created, the dialog closes, `onCreated` is called, and the rules are read
 * again. The controller resolves the matched signals, and its push reads
 * the lists again. A refusal, such as a rule with the same values that
 * already exists, shows in the dialog: "Not created: " and why.
 */
export function IgnoreDialog({
  signal,
  onCreated,
  onClose,
}: {
  readonly signal: Signal;
  readonly onCreated: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const moves = useIntakeMoves();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const wording = readSignalKindLabels(plugins, signal.kind);
  const fields = listDeclaredMatchValues(wording, signal.match);
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const match: SignalMatch = Object.fromEntries(
    fields.filter(({ field }) => !unchecked.has(field)).map(({ field, value }) => [field, value]),
  );
  const matched = useOpenSignalsMatchedByRule({ kind: signal.kind, match });
  const matchedIds = matched.state === "read" ? matched.signals.map((each) => each.id) : [];

  const create = useMutation({
    mutationFn: (rule: {
      readonly match: SignalMatch;
      readonly matchedIds: ReadonlyArray<string>;
    }) => client.ignoreRule.create({ payload: { kind: signal.kind, match: rule.match } }),
    // The list takes the matched signals off at once when the push arrives,
    // even under the pointer, as it does for the user's own answers.
    onMutate: (rule) => {
      moves.registerOwnChanges(rule.matchedIds);
    },
    onSuccess: async () => {
      dialogRef.current?.close();
      onCreated();
      await queryClient.invalidateQueries({ queryKey: queryKeys.ignoreRules() });
    },
    onError: (_error, rule) => {
      moves.forgetOwnChanges(rule.matchedIds);
    },
  });

  const toggle = (field: string, checked: boolean): void => {
    setUnchecked((current) => {
      const next = new Set(current);
      if (checked) next.delete(field);
      else next.add(field);
      return next;
    });
  };
  const checkedCount = fields.length - unchecked.size;

  return (
    <ConfirmDialog
      dialogRef={dialogRef}
      title="Ignore signals like this"
      actionLabel={create.isPending ? "Creating…" : "Create"}
      actionClass="accent"
      initialFocus="action"
      pending={create.isPending}
      error={create.error === null ? null : `Not created: ${readErrorMessage(create.error)}`}
      onConfirm={() => {
        create.mutate({ match, matchedIds });
      }}
      onClose={onClose}
    >
      <p>{describeIgnoreDialogEffect(wording.label)}</p>
      <div className="options ignore-fields">
        {fields.map(({ field, label, value }) => {
          const checked = !unchecked.has(field);
          // The last checked box stays focusable, so a keyboard user can
          // reach it and hear why it cannot be unchecked.
          const reason = checked && checkedCount === 1 ? LAST_MATCH_VALUE_REASON : undefined;
          return (
            <label key={field} className="option" title={reason}>
              <span className="choice-box">
                <input
                  type="checkbox"
                  checked={checked}
                  aria-disabled={reason !== undefined || undefined}
                  title={reason}
                  onChange={(event) => {
                    if (reason === undefined) toggle(field, event.target.checked);
                  }}
                />
                <CheckIcon size={12} />
              </span>
              <b>{label}</b>
              <small>{describeMatchValue(value)}</small>
            </label>
          );
        })}
      </div>
      <p>
        {describeRuleMatchesTakenOff(
          matched.state === "read" ? matched.signals.length : matched.state,
        )}
      </p>
      <p>
        {KIND_SWITCH_OFF_LINE.lead}
        <Link className="link" to="/settings/intake" search={{ kind: signal.kind }}>
          {KIND_SWITCH_OFF_LINE.link}
        </Link>
        {KIND_SWITCH_OFF_LINE.end}
      </p>
    </ConfirmDialog>
  );
}
