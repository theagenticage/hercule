/**
 * The Master Key as a migration receives it.
 *
 * A migration that re-encrypts secrets needs the key, and the migrations run
 * before the secrets domain exists, on a client of their own (spec 04, boot
 * order). So the boot opens the key first, when the machine already has one,
 * and `runMigrations` provides it here. A migration that needs the key asks
 * for it with `Effect.serviceOption`; every other migration never looks.
 *
 * It is a service of the database folder, not the secrets domain's `MasterKey`,
 * because the secrets domain imports this folder and a migration cannot import
 * it back. Both hold the same non-extractable AES-256-GCM key.
 */
import * as Context from "effect/Context";

export class MigrationMasterKey extends Context.Service<
  MigrationMasterKey,
  {
    readonly key: CryptoKey;
  }
>()("hercule/controller/db/MigrationMasterKey") {}
