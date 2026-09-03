/**
 * The migration set, embedded in the binary.
 *
 * Migrations are forward-only and statically imported: a compiled binary has no
 * filesystem to load `.sql` files from (spec 04, Migrations on boot; spec 15
 * section 8). Adding one means writing the file, importing it here, and
 * appending an entry with the next id. Ids are never reused and a landed
 * migration is never edited.
 */
import * as Effect from "effect/Effect";
import type { ResolvedMigration } from "effect/unstable/sql/Migrator";
import initial from "./0001-initial";

export const migrations: ReadonlyArray<ResolvedMigration> = [
  [1, "initial", Effect.succeed(initial)],
];

/** The schema version this binary carries: the highest embedded migration id. */
export const binaryVersion: number = migrations.reduce((highest, [id]) => Math.max(highest, id), 0);
