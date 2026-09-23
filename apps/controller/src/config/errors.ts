import { Schema } from "effect";
import type { InvalidOptionError } from "@hercule/home";

/** `config.toml` could not be read, or is not the TOML subset Hercule writes. */
export class ConfigFileError extends Schema.TaggedError<ConfigFileError>()("ConfigFileError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** A bootstrap key holds a value Hercule cannot use (spec 15 section 6). */
export class ConfigValueError extends Schema.TaggedError<ConfigValueError>()("ConfigValueError", {
  message: Schema.String,
}) {}

/**
 * A file or directory in the Hercule Home could not be created, secured,
 * written or removed (spec 15 section 5). `action` is the verb the error
 * message uses. The home layout is created, but the setup-url file is also
 * written and removed, and a message that says "cannot create" about a failed
 * removal would send the reader to the wrong place.
 */
export class HerculeHomeError extends Schema.TaggedError<HerculeHomeError>()("HerculeHomeError", {
  action: Schema.Literals(["create", "secure", "write", "remove"]),
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Everything that can stop the controller before the database opens. */
export type ConfigError =
  InvalidOptionError | ConfigFileError | ConfigValueError | HerculeHomeError;
