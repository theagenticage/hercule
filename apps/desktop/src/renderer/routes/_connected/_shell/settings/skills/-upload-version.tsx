import { useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  describeSkillSource,
  describeUploadFolderProblem,
  readErrorMessage,
  type SkillImportOutcome,
} from "@hercule/client-core";
import type { Skill } from "@hercule/contract";
import { skillsQuery } from "../../../../../app/queries";
import { ConfirmDialog } from "../../../../../screens/confirm-dialog";
import { InlineCode } from "../../../../../screens/inline-code";
import { SettingsHeaderActions } from "../../../../../screens/settings/settings-frame";
import { importPickedSkill } from "./-import-picked-skill";

/**
 * Renders Upload new version, the header's button on the page of `skill`
 * (spec 17 §Settings, Skills), and the line under the header that tells how
 * the last upload went.
 *
 * The button asks main for a folder, which must hold this one skill. Main
 * then builds the skill's archive, and `skill.import` sends it with
 * `replace` and no source fields, so the skill's source becomes "Uploaded".
 * A skill with a GitHub source asks first, in a dialog, because its update
 * checks stop. Content that is already the current revision stores no
 * revision, and the line says so.
 *
 * After the upload, the list and the open skill are read again, so the page
 * shows the new revision and source.
 */
export function UploadVersion({ skill }: { readonly skill: Skill }): JSX.Element {
  const { bridge } = useRouteContext({ from: "__root__" });
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [confirming, setConfirming] = useState(false);
  const { name } = skill;

  const upload = useMutation({
    mutationFn: async (): Promise<SkillImportOutcome> => {
      // No source, so the skill's source becomes "Uploaded".
      const outcome = await importPickedSkill(bridge, client, { name, source: null }, true);
      // Any outcome, also a refusal, may mean the page is out of date. A
      // refusal by main sent nothing, but reading again costs one request.
      await queryClient.invalidateQueries({ queryKey: skillsQuery(client).queryKey });
      return outcome;
    },
    onSettled: () => {
      dialogRef.current?.close();
    },
  });

  // Answers the pick, and why the picked folder cannot be uploaded, or null
  // when it can or nothing was picked.
  const pick = useMutation({
    mutationFn: async () => {
      const picked = await bridge.skillFolders.pick();
      const folderProblem =
        picked._tag === "Picked"
          ? describeUploadFolderProblem(name, {
              displayPath: picked.displayPath,
              skillNames: picked.skills.map((each) => each.name),
            })
          : null;
      return { picked, folderProblem };
    },
    onMutate: () => {
      upload.reset();
    },
    onSuccess: ({ picked, folderProblem }) => {
      if (picked._tag !== "Picked" || folderProblem !== null) return;
      if (skill.source.kind === "github") setConfirming(true);
      else upload.mutate();
    },
  });

  const busy = pick.isPending || upload.isPending;
  const folderProblem = pick.data?.folderProblem ?? null;
  const outcome = upload.data;
  return (
    <>
      <SettingsHeaderActions>
        <button
          type="button"
          className="btn btn--sm"
          aria-disabled={busy}
          onClick={() => {
            if (!busy) pick.mutate();
          }}
        >
          Upload new version
        </button>
      </SettingsHeaderActions>
      {pick.data?.picked._tag === "Unreadable" && (
        <p className="set-err" role="alert">
          {pick.data.picked.reason}
        </p>
      )}
      {pick.error !== null && (
        <p className="set-err" role="alert">
          {`Could not open the folder: ${readErrorMessage(pick.error)}`}
        </p>
      )}
      {folderProblem !== null && (
        <p className="set-err" role="alert">
          <InlineCode text={folderProblem} />
        </p>
      )}
      {outcome?.kind === "refused" && (
        <p className="set-err" role="alert">
          <InlineCode text={`Not uploaded: ${outcome.reason}`} />
        </p>
      )}
      {upload.error !== null && (
        <p className="set-err" role="alert">
          {`Not uploaded: ${readErrorMessage(upload.error)}`}
        </p>
      )}
      {outcome?.kind === "unchanged" && (
        <p className="set-note" role="status">
          No new revision: these files are the current revision.
        </p>
      )}
      {confirming && (
        <ConfirmDialog
          dialogRef={dialogRef}
          title={`Upload a new version of ${name}?`}
          actionLabel={upload.isPending ? "Uploading…" : "Upload"}
          actionClass="accent"
          initialFocus="close"
          pending={upload.isPending}
          onConfirm={() => {
            upload.mutate();
          }}
          onClose={() => setConfirming(false)}
        >
          <p>
            {`${name} comes from ${describeSkillSource(skill.source)}. After the upload its source is "Uploaded", so Hercule stops checking it for updates.`}
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
