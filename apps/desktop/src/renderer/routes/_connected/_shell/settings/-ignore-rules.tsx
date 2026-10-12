import { useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  describeIgnoreRuleCatches,
  listPluginIgnoreRules,
  queryKeys,
  readErrorMessage,
} from "@hercule/client-core";
import type { IgnoreRuleWithCatches } from "@hercule/contract";
import { ignoreRulesQuery, settingsQuery } from "../../../../app/queries";
import { ConfirmDialog } from "../../../../screens/confirm-dialog";
import { IgnoreRuleRow } from "../../../../screens/settings/intake/ignore-rule-row";

/**
 * Renders the Ignore Rules list of the plugin `pluginId` on Settings > Intake:
 * one row per rule of the plugin's kinds, each with what it caught and a
 * Delete that asks first. A rule belongs to no Connection, so the list is the
 * same under every segment. With no rules, nothing is drawn.
 *
 * The section's loader reads the rules. No live push covers them, so a
 * delete reads them again itself once the controller has deleted the rule.
 */
export function IgnoreRules({ pluginId }: { readonly pluginId: string }): JSX.Element | null {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const rules = listPluginIgnoreRules(useSuspenseQuery(ignoreRulesQuery(client)).data, pluginId);
  const retentionDays = useSuspenseQuery(settingsQuery(client)).data.controller?.[
    "retention.events"
  ];
  const [deleting, setDeleting] = useState<IgnoreRuleWithCatches | null>(null);
  if (rules.length === 0 && deleting === null) return null;
  return (
    <>
      {rules.length > 0 && <h3 className="intake-list-head">Ignore Rules</h3>}
      {rules.map((rule) => (
        <IgnoreRuleRow
          key={rule.id}
          text={rule.text}
          catches={describeIgnoreRuleCatches(rule.caughtCount, retentionDays)}
          onDelete={() => {
            setDeleting(rule);
          }}
        />
      ))}
      {deleting !== null && (
        <DeleteIgnoreRuleDialog
          rule={deleting}
          onClose={() => {
            setDeleting(null);
          }}
        />
      )}
    </>
  );
}

/**
 * Asks before the Ignore Rule `rule` is deleted, and deletes it. Cancel has
 * the focus, because the delete cannot be undone. Once the delete succeeds,
 * the dialog closes and the rules are read again. A refusal shows in the
 * dialog: "Could not delete: " and why.
 */
function DeleteIgnoreRuleDialog({
  rule,
  onClose,
}: {
  readonly rule: IgnoreRuleWithCatches;
  readonly onClose: () => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const remove = useMutation({
    mutationFn: () => client.ignoreRule.delete({ params: { id: rule.id } }),
    onSuccess: async () => {
      dialogRef.current?.close();
      await queryClient.invalidateQueries({ queryKey: queryKeys.ignoreRules() });
    },
  });
  return (
    <ConfirmDialog
      dialogRef={dialogRef}
      title="Delete this Ignore Rule?"
      actionLabel={remove.isPending ? "Deleting…" : "Delete"}
      actionClass="danger"
      initialFocus="close"
      pending={remove.isPending}
      error={remove.error === null ? null : `Could not delete: ${readErrorMessage(remove.error)}`}
      onConfirm={() => {
        remove.mutate();
      }}
      onClose={onClose}
    >
      <p>
        Signals that match <b>{rule.text}</b> are raised again from the next event. Nothing the rule
        already caught comes back.
      </p>
    </ConfirmDialog>
  );
}
