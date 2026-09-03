import { Schema } from "effect";
import type { InvalidOptionError } from "@hydra/home";

/** `config.toml` could not be read, or is not the TOML subset Hydra writes. */
export class ConfigFileError extends Schema.TaggedError<ConfigFileError>()("ConfigFileError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** A bootstrap key holds a value Hydra cannot use (spec 15 section 6). */
export class ConfigValueError extends Schema.TaggedError<ConfigValueError>()("ConfigValueError", {
  message: Schema.String,
}) {}

/**
 * Something in the Hydra Home could not be put where it belongs (spec 15
 * section 5). `action` is the verb the message needs: the home layout is
 * created, but the setup-url file is also written and removed, and a failure
 * that says "cannot create" about a removal sends the reader to the wrong
 * place.
 */
export class HydraHomeError extends Schema.TaggedError<HydraHomeError>()("HydraHomeError", {
  action: Schema.Literals(["create", "secure", "write", "remove"]),
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Everything that can stop the controller before the database opens. */
export type ConfigError = InvalidOptionError | ConfigFileError | ConfigValueError | HydraHomeError;
