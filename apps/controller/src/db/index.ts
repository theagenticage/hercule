/**
 * The controller's state store: one SQLite database, ambient transactions,
 * forward-only migrations (spec 04, ADR 0004).
 */
export { DatabaseError, databaseError, MEMORY, openDatabase, withTransaction } from "./client";
export { mintUuid, uuidFromString, uuidToString, UUID_PATTERN } from "./id";
export {
  CursorError,
  decodeCursor,
  encodeCursor,
  type CursorScope,
  type Page,
  type PageRequest,
} from "./page";
export {
  backupBeforeMigration,
  databaseVersion,
  migrate,
  runMigrations,
  SchemaVersionError,
} from "./migrate";
export { binaryVersion } from "./migrations/index";
