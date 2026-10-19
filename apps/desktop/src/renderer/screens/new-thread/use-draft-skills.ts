import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  findDraftSkillsPreview,
  listLibrarySessionSkills,
  type DraftView,
} from "@hercule/client-core";
import { previewSkillsQuery, skillsQuery } from "../../app/queries";
import type { ComposerSkills } from "../session/message-field";

/**
 * Reads the skills a Draft Thread would have and returns them for its
 * composer, with a function that reads them again.
 *
 * - When the draft has a runner and opens at least one repo, the controller
 *   lists them (`session.previewSkills`): the Skill Library and the skills in
 *   the repos' checkouts.
 * - Otherwise the draft would have the Skill Library's skills only, so those
 *   are listed, without descriptions because the library's list holds none.
 *
 * The reads are not suspense: skills are an addition to the composer, so a
 * runner that is offline never hides it. While a read is under way or has
 * failed, `skills` is `undefined`.
 */
export const useDraftSkills = (view: DraftView): ComposerSkills => {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const filter = findDraftSkillsPreview(
    view.fields.workspace.value,
    view.fields.machine.runnerId,
    view.catalogs.workspaces,
  );
  const previewing = filter !== null;
  const preview = useQuery(previewSkillsQuery(client, filter));
  const library = useQuery({ ...skillsQuery(client), enabled: !previewing });
  const libraryData = library.data;
  const skills = useMemo(
    () =>
      previewing
        ? preview.data?.items
        : libraryData === undefined
          ? undefined
          : listLibrarySessionSkills(libraryData),
    [previewing, preview.data, libraryData],
  );
  const source = previewing ? preview : library;
  return {
    skills,
    refresh: () => {
      void source.refetch();
    },
  };
};
