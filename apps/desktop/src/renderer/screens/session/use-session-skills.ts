import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { SessionSkill } from "@hercule/contract";
import { sessionSkillsQuery } from "../../app/queries";

/** What `useSessionSkills` returns before the read answers, and when it fails. One shared map. */
const NO_SKILLS: ReadonlyMap<string, SessionSkill> = new Map();

/**
 * Reads the skills of session `sessionId` and returns them by name, to draw
 * the chips of a sent message or a queued input. Returns an empty map while
 * the read is under way and when it fails: a chip is decoration, so a
 * missing list never hides the message around it.
 *
 * The read is not suspense, and it is not made again each time a message
 * mounts. `sessionSkillsQuery` reads again on every mount, because the
 * composer's list must be current when it opens, but a transcript mounts a
 * message each time it scrolls one into view, and each read asks the runner
 * for its disk. A chip needs only the description for its hover card, so a
 * list read once is enough. The composer's own read still refreshes it.
 *
 * The map keeps its identity until the list changes.
 */
export const useSessionSkills = (sessionId: string): ReadonlyMap<string, SessionSkill> => {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { data } = useQuery({ ...sessionSkillsQuery(client, sessionId), staleTime: Infinity });
  return useMemo(
    () =>
      data === undefined ? NO_SKILLS : new Map(data.items.map((skill) => [skill.name, skill])),
    [data],
  );
};
