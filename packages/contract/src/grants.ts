/**
 * The grant vocabulary.
 *
 * A grant is part of the wire contract:
 *
 * - a 403 response puts the missing grant in `details.grant`;
 * - `profile.create` takes a list of grants;
 * - the CLI's `--help` prints the grant an operation needs.
 *
 * So the vocabulary lives here rather than only inside the controller.
 * `grants.test.ts` checks that this list is the same list the controller
 * enforces, so the two can never drift apart.
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
  // `audit` is the security entries of the event log, which `read` alone does
  // not return: an entry about a secret, a credential or the user's account is
  // withheld from a profile that has not been given this verb as well.
  event: ["read", "emit", "audit"],
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

/** A grant family: the broad area of operations a grant covers. */
export type GrantFamily = keyof typeof GRANT_FAMILIES;

/** A grant, written `<family>.<verb>`. A 403 response reports the missing grant, and an escalation asks for one. */
export type Grant = {
  [F in GrantFamily]: `${F}.${(typeof GRANT_FAMILIES)[F][number]}`;
}[GrantFamily];

/** Every grant in the vocabulary, family order then verb order. */
export const ALL_GRANTS: ReadonlyArray<Grant> = Object.entries(GRANT_FAMILIES).flatMap(
  ([family, verbs]) => verbs.map((verb) => `${family}.${verb}` as Grant),
);

/** A grant string, validated against the closed vocabulary. */
export const GrantSchema = Schema.Literals(ALL_GRANTS);
