/**
 * Re-encrypts every secret in a database from one key to another. A
 * promotion uses it twice: the old controller re-encrypts its copy of the
 * database from its Master Key to the transfer key, and the new machine
 * re-encrypts what it received from the transfer key to its own new Master
 * Key. Neither key ever leaves its machine; only the token the transfer key
 * is derived from travels, and separately from the data.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { withTransaction } from "../db";
import {
  decryptSecretValue,
  encryptSecretValue,
  type Bytes,
  type SecretDecryptError,
} from "./cipher";
import type { SecretOwnerKind } from "./repository";

/**
 * Decrypts every secrets row under `from`, encrypts it again under `to`, and
 * writes the new nonce and ciphertext to the same row, in one transaction.
 * The associated data stays the row's owner and name. Fails with
 * `SecretDecryptError`, and changes nothing, when any row does not decrypt
 * under `from`.
 */
export const rewrapSecrets = (
  from: CryptoKey,
  to: CryptoKey,
): Effect.Effect<void, SqlError | SecretDecryptError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* withTransaction(
      sql,
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly id: Bytes;
          readonly owner_kind: SecretOwnerKind;
          readonly owner_id: string;
          readonly name: string;
          readonly nonce: Bytes;
          readonly ciphertext: Bytes;
        }>`SELECT id, owner_kind, owner_id, name, nonce, ciphertext FROM secrets`;
        for (const row of rows) {
          const owner = { kind: row.owner_kind, id: row.owner_id };
          const plaintext = yield* decryptSecretValue(from, owner, row.name, row);
          const { nonce, ciphertext } = yield* encryptSecretValue(to, owner, row.name, plaintext);
          yield* sql`UPDATE secrets SET nonce = ${nonce}, ciphertext = ${ciphertext} WHERE id = ${row.id}`;
        }
      }),
    );
  });
