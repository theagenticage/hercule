/**
 * Reads who the Connection's credential belongs to: the workspace and the
 * signed-in user. Several feeds need both, the workspace to build External
 * Refs and the user to tell what is theirs.
 */
import { Effect, Schema } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import { callLinear, type LinearFailure } from "../api";
import { VIEWER_FIELDS, ViewerFields } from "../linear-objects";
import type { PollIdentity } from "./filter";

const IDENTITY_QUERY = `query LinearIdentity { ${VIEWER_FIELDS} }`;

const IdentityAnswer = Schema.Struct(ViewerFields);

/** Reads the workspace and the signed-in user in one request. Fails as `callLinear` does. */
export const readIdentity = (
  authorization: string,
): Effect.Effect<PollIdentity, LinearFailure, HttpClient.HttpClient> =>
  callLinear(authorization, { name: "LinearIdentity", text: IDENTITY_QUERY }, IdentityAnswer).pipe(
    Effect.map((answer) => ({ workspace: answer.organization, userId: answer.viewer.id })),
  );
