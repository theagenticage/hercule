/**
 * The operation `user.setPassword`, the only way to change the password.
 *
 * The current password is verified even though the caller already has a
 * credential. A bearer token left in a terminal, a browser or a credential file
 * is enough to read Hercule's data, but on purpose it is not enough to take
 * over the account.
 *
 * Credentials issued under the old password stay valid after the change. A
 * password change is usually routine, not a response to a compromise, and
 * logging the user out of every device would be a surprise. A credential the
 * user wants gone can be revoked by name (`apiKey.revoke`) or by logging out.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createValidationError,
  type Forbidden,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { requireUserActor, USER_ACTOR } from "../actor";
import { withTransaction } from "../db";
import { AuditLog } from "../events";
import { hashPassword, PasswordCost, verifyPassword } from "./password";
import { Users } from "./repository";

/** The input of a password change. Neither value is kept after the call. */
export interface SetPasswordInput {
  readonly current: string;
  readonly next: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const users = yield* Users;
  const audit = yield* AuditLog;
  const cost = yield* PasswordCost;

  return {
    /**
     * Verifies the current password and stores the new one. Returns an empty
     * object. A wrong current password fails with a validation error on the
     * `current` field, not `unauthenticated`: the caller is authenticated, and
     * one wrong field in a request is what `validation` is for.
     */
    setPassword: (
      input: SetPasswordInput,
    ): Effect.Effect<Record<string, never>, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        const actor = yield* requireUserActor("user.setPassword");
        const user = yield* users.findById(actor.userId);
        if (Option.isNone(user)) {
          // The caller's credential was just resolved through this row, so the
          // row cannot be missing.
          return yield* Effect.die(`the actor's user ${actor.userId} does not exist`);
        }

        const matches = yield* verifyPassword(input.current, user.value.passwordHash);
        if (!matches) {
          return yield* Effect.fail(
            createValidationError([
              { path: ["current"], message: "the current password is incorrect" },
            ]),
          );
        }

        // Hashing takes tens of milliseconds and SQLite has one writer, so hash
        // before the transaction opens, not inside it.
        const passwordHash = yield* hashPassword(input.next, cost);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* users.setPasswordHash(actor.userId, passwordHash);
            yield* audit.append({
              kind: "user.passwordChanged",
              actor: USER_ACTOR,
              payload: {},
            });
            return {};
          }),
        );
      }),
  };
});

/** The user service. */
export class User extends Context.Service<User, Effect.Success<typeof make>>()(
  "hercule/controller/users/User",
) {}

export const UserLayer: Layer.Layer<User, never, SqlClient.SqlClient | Users | AuditLog> =
  Layer.effect(User)(make);
