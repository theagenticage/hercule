/**
 * The grant vocabulary (spec 13 section 6.1).
 *
 * A grant is part of the wire contract: a 403 names the missing grant in
 * `details.grant`, `profile.create` takes a list of them, and the CLI's
 * `--help` prints the grant an operation needs. It therefore lives here rather
 * than only inside the controller. `grants.test.ts` asserts this list is the
 * same list the controller enforces, so the two can never drift.
 */
import { Schema } from "effect";

/** The grant families and their verbs. Families are coarser than operations. */
export const GRANT_FAMILIES = {
  task: ["read", "create", "update", "delete"],
  workflow: ["read", "write", "run", "submit"],
  run: ["read", "write"],
  session: ["read", "spawn", "steer"],
  subscription: ["read", "write"],
  notification: ["read", "write"],
  settings: ["read", "write"],
  event: ["read", "emit"],
  connection: ["read", "manage", "use"],
  infra: ["read", "write"],
  workspace: ["read", "write"],
  agent: ["read", "write"],
  memory: ["read", "write"],
  permission: ["read", "write"],
  project: ["read", "write"],
  resource: ["read", "write"],
  secret: ["read", "write"],
  credential: ["read", "write"],
} as const satisfies Record<string, ReadonlyArray<string>>;

/** One grant family: the coarse operation area a grant names. */
export type GrantFamily = keyof typeof GRANT_FAMILIES;

/** One grant, family-dot-verb: what a 403 names and an escalation asks for. */
export type Grant = {
  [F in GrantFamily]: `${F}.${(typeof GRANT_FAMILIES)[F][number]}`;
}[GrantFamily];

/** Every grant in the vocabulary, family order then verb order. */
export const ALL_GRANTS: ReadonlyArray<Grant> = Object.entries(GRANT_FAMILIES).flatMap(
  ([family, verbs]) => verbs.map((verb) => `${family}.${verb}` as Grant),
);

/** A grant string, validated against the closed vocabulary. */
export const GrantSchema = Schema.Literals(ALL_GRANTS);
