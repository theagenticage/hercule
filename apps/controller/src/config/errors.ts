import { Schema } from "effect";

/** A malformed global option on the command line (`--home`, `-c key=value`). */
export class InvalidOptionError extends Schema.TaggedError<InvalidOptionError>()(
  "InvalidOptionError",
  { option: Schema.String, message: Schema.String },
) {}

/** `config.toml` could not be read, or is not the TOML subset Hydra writes. */
export class ConfigFileError extends Schema.TaggedError<ConfigFileError>()("ConfigFileError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** A bootstrap key holds a value Hydra cannot use (spec 15 section 6). */
export class ConfigValueError extends Schema.TaggedError<ConfigValueError>()("ConfigValueError", {
  message: Schema.String,
}) {}

/** The Hydra Home layout could not be created or read (spec 15 section 5). */
export class HydraHomeError extends Schema.TaggedError<HydraHomeError>()("HydraHomeError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Everything that can stop the controller before the database opens. */
export type ConfigError = InvalidOptionError | ConfigFileError | ConfigValueError | HydraHomeError;
