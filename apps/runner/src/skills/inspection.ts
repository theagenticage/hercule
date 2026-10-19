/**
 * Answers the controller's question which repository skills a workspace
 * offers (spec 06 section 9.4).
 */
import * as Effect from "effect/Effect";
import { MAX_MESSAGE_LENGTH, type RepositorySkillsInspection } from "@hercule/protocol";
import { describeCause } from "../report";
import type { Workspaces } from "../workspaces";
import { listRepositorySkills } from "./repository";

/**
 * Returns what the workspace offers, ready to send to the controller: the
 * skills without their absolute paths, which stay on the runner, and the
 * skipped folders. Never fails: a workspace this runner does not have, a
 * workspace folder that cannot be read, or an unexpected error becomes the
 * `failed` outcome with a message for the user.
 */
export const inspectRepositorySkills = (
  workspaces: Pick<Workspaces, "resolve">,
  workspaceId: string,
): Effect.Effect<RepositorySkillsInspection["outcome"]> =>
  Effect.gen(function* () {
    const workspace = yield* workspaces.resolve(workspaceId);
    if (workspace === undefined) {
      return yield* Effect.fail(`The runner has no workspace \`${workspaceId}\`.`);
    }
    const listing = yield* listRepositorySkills(workspace);
    return {
      status: "listed" as const,
      skills: listing.skills.map(({ checkoutName, name, description, path }) => ({
        checkoutName,
        name,
        description,
        path,
      })),
      skipped: listing.skipped,
    };
  }).pipe(
    // A failure is already a sentence for the user. Only a defect needs describing.
    Effect.catch((message: string) =>
      Effect.succeed({ status: "failed" as const, message: message.slice(0, MAX_MESSAGE_LENGTH) }),
    ),
    Effect.catchCause((cause) =>
      Effect.succeed({
        status: "failed" as const,
        message: describeCause(cause, MAX_MESSAGE_LENGTH),
      }),
    ),
  );
