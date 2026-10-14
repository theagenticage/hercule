/**
 * The repositories a session has checked out, and the repository a call is
 * about when it names none (spec 19 section 3.2).
 *
 * Discussions and Wiki Pages belong to one Resource of kind `repo`. A session
 * may leave the Resource out of a create, and the one repository checked out
 * in its workspace is taken instead. The coordination paragraph a session
 * starts with lists the same repositories.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createNotFoundError,
  createValidationError,
  type NotFound,
  type Validation,
} from "@hercule/contract";
import { CurrentActor } from "../actor";
import { uuidFromString, uuidToString } from "../db";
import { resourceRepository } from "../resources";

/** A Resource of kind `repo`, by its id and its canonical remote, such as `github.com/acme/web`. */
export interface RepositoryRef {
  readonly resourceId: string;
  readonly repository: string;
}

/**
 * Returns the repositories checked out in a session's workspace, in the order
 * the workspace lists its checkouts. Returns an empty list for a session with
 * no workspace, and for a session that does not exist.
 */
export const listCheckedOutRepositories = (
  sessionId: string,
): Effect.Effect<ReadonlyArray<RepositoryRef>, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly id: Uint8Array; readonly canonical_remote: string }>`
      SELECT r.id, r.canonical_remote
      FROM sessions s
      JOIN checkouts c ON c.workspace_id = s.workspace_id
      JOIN resources r ON r.id = c.resource_id
      WHERE s.id = ${uuidFromString(sessionId)} AND r.kind = 'repo'
      ORDER BY c.position
    `;
    return rows.map((row) => ({
      resourceId: uuidToString(row.id),
      repository: row.canonical_remote,
    }));
  });

/** Returns the refusal of a Resource that is not a repo, at `resourceId`. */
const refuseOtherKind = (resourceId: string, kind: string): Validation =>
  createValidationError([
    {
      path: ["resourceId"],
      message: `resource ${resourceId} is a ${kind}; only a repo has discussions and a wiki`,
    },
  ]);

/**
 * Checks the `resourceId` a listing is filtered by. Fails with `Validation`
 * when it names a Resource that is not a repo. An id that names no Resource
 * passes: the listing then matches nothing, as every filter on a missing
 * record does (spec 19 section 3.2).
 */
export const ensureRepositoryOrNone = (
  resourceId: string,
): Effect.Effect<void, Validation | SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const resources = yield* resourceRepository;
    const resource = yield* resources.one(resourceId);
    if (Option.isSome(resource) && resource.value.kind !== "repo") {
      return yield* Effect.fail(refuseOtherKind(resourceId, resource.value.kind));
    }
  });

/** Formats repositories as the refusal messages list them: `github.com/acme/web (<id>)`. */
const formatRepositories = (repositories: ReadonlyArray<RepositoryRef>): string =>
  repositories.map(({ resourceId, repository }) => `${repository} (${resourceId})`).join(", ");

/**
 * Returns the repository a create is about.
 *
 * - With a `resourceId`, it is that Resource. Fails with `NotFound` when no
 *   Resource has that id, and with `Validation` when the Resource is not a
 *   repo.
 * - Without one, a session's call takes the one repository checked out in its
 *   workspace. Fails with `Validation` at `resourceId` when the session has
 *   none or several; the message lists them and says to pass `--resource`.
 * - Any other caller must give a `resourceId`, or fails with `Validation`.
 */
export const resolveRepository = (
  resourceId: string | undefined,
): Effect.Effect<RepositoryRef, Validation | NotFound | SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    if (resourceId !== undefined) {
      const resources = yield* resourceRepository;
      const resource = yield* resources.one(resourceId);
      if (Option.isNone(resource))
        return yield* Effect.fail(
          createNotFoundError(
            "no such resource; pass a --resource id from the repository lines in your instructions, or leave --resource out to use the repository checked out in your workspace",
          ),
        );
      if (resource.value.kind !== "repo") {
        return yield* Effect.fail(refuseOtherKind(resourceId, resource.value.kind));
      }
      return { resourceId, repository: resource.value.canonicalRemote };
    }
    const actor = yield* CurrentActor;
    if (actor._tag !== "session") {
      return yield* Effect.fail(
        createValidationError([
          { path: ["resourceId"], message: "name the repository with --resource <id>" },
        ]),
      );
    }
    const repositories = yield* listCheckedOutRepositories(actor.sessionId);
    if (repositories.length === 1) return repositories[0]!;
    const message =
      repositories.length === 0
        ? "this session has no repository checked out, so name the repository with --resource <id>"
        : `this session has ${String(repositories.length)} repositories checked out: ${formatRepositories(repositories)}. Name one with --resource <id>`;
    return yield* Effect.fail(createValidationError([{ path: ["resourceId"], message }]));
  });
