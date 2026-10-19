import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { buildDraftSkillsPreview, readErrorMessage, type DraftView } from "@hercule/client-core";
import { previewSkillsQuery } from "../../app/queries";
import type { ComposerSkills } from "../session/message-field";

/**
 * Reads the skills a Draft Thread would have and returns them for its
 * composer, with a function that reads them again.
 *
 * The controller lists them (`session.previewSkills`): the Skill Library and,
 * when the draft has a runner and opens at least one repo, the skills in the
 * repos' checkouts. A draft with no runner or no repo gets the Skill Library
 * alone, with its descriptions.
 *
 * The read is not suspense: skills are an addition to the composer, so a
 * runner that is offline never hides it. While the first read is under way or
 * has failed, `skills` is `undefined`, and `failure` tells the two apart.
 */
export const useDraftSkills = (view: DraftView): ComposerSkills => {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const filter = buildDraftSkillsPreview(
    view.fields.workspace.value,
    view.fields.machine.runnerId,
    view.catalogs.workspaces,
  );
  const preview = useQuery(previewSkillsQuery(client, filter));
  return {
    skills: preview.data?.items,
    failure: preview.error === null ? undefined : readErrorMessage(preview.error),
    refresh: () => {
      void preview.refetch();
    },
  };
};
