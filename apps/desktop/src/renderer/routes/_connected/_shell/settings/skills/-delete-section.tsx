import { useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { readErrorMessage } from "@hercule/client-core";
import { skillQuery, skillsQuery } from "../../../../../app/queries";
import { ConfirmDialog } from "../../../../../screens/confirm-dialog";
import { SettingRow } from "../../../../../screens/settings/setting-row";

/**
 * Renders the Delete section of skill `name`, the last section of its page
 * (spec 17 §Settings, Skills). Delete… asks for a confirmation in a dialog
 * before anything is deleted. A refusal by the controller stays in the
 * dialog.
 *
 * Once the controller has deleted the skill, the page goes to the list,
 * whose loader reads the list again. The skill's cached read is then
 * dropped, so opening its address again reads it rather than drawing the
 * deleted skill first.
 */
export function DeleteSection({ name }: { readonly name: string }): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => client.skill.delete({ params: { name } }),
    onSuccess: async () => {
      dialogRef.current?.close();
      // The page leaves before its read is dropped: the page reads the
      // skill, and would otherwise read it again and fail.
      await navigate({ to: "/settings/skills" });
      queryClient.removeQueries({ queryKey: skillQuery(client, name).queryKey, exact: true });
    },
    // The refusal may mean the skill is already gone, so the list is out of date.
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: skillsQuery(client).queryKey, exact: true });
    },
  });
  return (
    <section className="set-sec">
      <h2>{`Delete ${name}`}</h2>
      <SettingRow
        label="Delete skill"
        hint="Deletes it and all its revisions."
        control={(labels) => (
          <button
            type="button"
            className="btn btn--danger"
            {...labels}
            onClick={() => {
              remove.reset();
              setConfirming(true);
            }}
          >
            Delete…
          </button>
        )}
      />
      {confirming && (
        <ConfirmDialog
          dialogRef={dialogRef}
          title={`Delete ${name}?`}
          actionLabel={remove.isPending ? "Deleting…" : "Delete"}
          actionClass="danger"
          initialFocus="close"
          pending={remove.isPending}
          error={
            remove.error === null ? null : `Could not delete: ${readErrorMessage(remove.error)}`
          }
          onConfirm={() => {
            remove.mutate();
          }}
          onClose={() => setConfirming(false)}
        >
          <p>{`This deletes ${name} and all its revisions. This cannot be undone.`}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
