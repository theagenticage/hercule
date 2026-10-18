import { useEffect, useRef, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  describeUpdateAll,
  isConflict,
  listSkillUpdates,
  listSkillUpdateWarnings,
  mayUpdateChangeApprovals,
  readErrorMessage,
} from "@hercule/client-core";
import type { SkillUpdate } from "@hercule/contract";
import { readSkillsAgain, skillsQuery } from "../../../../../app/queries";
import { ConfirmDialog } from "../../../../../screens/confirm-dialog";
import { InlineCode } from "../../../../../screens/inline-code";

/**
 * Renders the confirmation Update all asks for (spec 17 §Settings, Skills,
 * Updates): "Update 3 skills?", the skills that take their update, and each
 * skill whose update may change approvals, by the badge's rule, with that
 * update's warning lines. The user never applies such an update without
 * seeing it.
 *
 * The confirmation shows the updates of the list as it is read now, and
 * Update all sends exactly those with `skill.applyUpdates`. A `conflict`
 * means a check found a newer update since: the controller's message stays
 * in the confirmation, above the updates, and the list is read again, so
 * the confirmation shows the new updates, and confirming again sends them.
 * Once no update waits any more, the confirmation closes.
 */
export function UpdateAllDialog({ onClose }: { readonly onClose: () => void }): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const skills = useSuspenseQuery(skillsQuery(client)).data;
  const updates = listSkillUpdates(skills);
  const changingApprovals = skills.filter(mayUpdateChangeApprovals);

  const apply = useMutation({
    mutationFn: (shown: ReadonlyArray<SkillUpdate>) =>
      client.skill.applyUpdates({ payload: { updates: shown } }),
    onSuccess: () => {
      dialogRef.current?.close();
    },
    onSettled: () => readSkillsAgain(queryClient),
  });

  const nothingWaits = updates.length === 0;
  useEffect(() => {
    if (nothingWaits) dialogRef.current?.close();
  }, [nothingWaits]);

  const error = apply.error;
  return (
    <ConfirmDialog
      dialogRef={dialogRef}
      title={`Update ${String(updates.length)} ${updates.length === 1 ? "skill" : "skills"}?`}
      actionLabel={apply.isPending ? "Updating…" : "Update all"}
      actionClass="accent"
      initialFocus="close"
      pending={apply.isPending}
      onConfirm={() => {
        apply.mutate(updates);
      }}
      onClose={onClose}
    >
      {error !== null && (
        <p className="fl-err" role="alert">
          {isConflict(error) ? (
            <InlineCode text={readErrorMessage(error)} />
          ) : (
            `Could not update: ${readErrorMessage(error)}`
          )}
        </p>
      )}
      <p>{describeUpdateAll(updates.map(({ name }) => name))}</p>
      {changingApprovals.length > 0 && (
        <>
          <p>
            {changingApprovals.length === 1
              ? "One update may change approvals:"
              : "These updates may change approvals:"}
          </p>
          <ul className="skill-approvals">
            {changingApprovals.map((skill) => (
              <li key={skill.name}>
                <b>{skill.name}</b>
                {listSkillUpdateWarnings(skill).map((line) => (
                  <span key={line.text}>
                    {line.text}
                    {line.tools.length > 0 && " "}
                    {/* A rule may repeat, so its place is its key. */}
                    {line.tools.map((tool, at) => (
                      <code key={at}>{tool}</code>
                    ))}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </>
      )}
    </ConfirmDialog>
  );
}
