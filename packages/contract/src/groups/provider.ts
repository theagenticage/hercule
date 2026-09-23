/**
 * Provider instances. Everything routes on the instance id, not the provider
 * id: one provider can have several accounts, kept apart by their config
 * directories.
 * `displayName`, `binaryName` and `declared` come from the registering plugin
 * at read time, not from the stored row.
 */
import { Schema } from "effect";
import { DeclaredCapabilities, MAX_CONTRIBUTION_NAME_LENGTH } from "@hercule/plugin-host";
import { ModelDescriptor, SnapshotAuth } from "@hercule/protocol";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import {
  Forbidden,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "../errors";
import { Id, Timestamp } from "../ids";
import { Authenticated } from "../security";
import { bounded } from "../strings";

/**
 * The longest name a provider instance may carry. It is the same limit as a
 * contribution's name, because the controller names the default instance
 * after its provider.
 */
export const MAX_PROVIDER_INSTANCE_NAME_LENGTH = MAX_CONTRIBUTION_NAME_LENGTH;

const ProviderInstanceName = bounded(1, MAX_PROVIDER_INSTANCE_NAME_LENGTH);

/** Re-exported so a reader of an instance needs only this package. */
export { DeclaredCapabilities } from "@hercule/plugin-host";

/** Re-exported rather than copied, so the public shape cannot drift from the wire shape. */
export { ModelDescriptor, ModelOption, SnapshotAuth } from "@hercule/protocol";

/**
 * How the harness version a runner reported compares with the versions this
 * build was tested with. `unknown` means the machine reported no version, or
 * the provider has no minimum version set.
 */
export const VersionVerdict = Schema.Literals(["unknown", "below-floor", "ok", "above-tested-max"]);

export type VersionVerdict = Schema.Schema.Type<typeof VersionVerdict>;

export const CapabilitySnapshot = Schema.Struct({
  runnerId: Id,
  probedAt: Timestamp,
  harnessVersion: Schema.NullOr(Schema.String),
  versionVerdict: VersionVerdict,
  auth: SnapshotAuth,
  models: Schema.Array(ModelDescriptor),
});

export type CapabilitySnapshot = Schema.Schema.Type<typeof CapabilitySnapshot>;

/**
 * One secret config field of a provider, described in the plugin's own words,
 * and whether this instance has a value stored for it. The value is written
 * through `secret.set` and never read back: an instance shows that a
 * credential is there, never what it is.
 */
export const ProviderSecretField = Schema.Struct({
  name: Schema.String,
  title: Schema.String,
  description: Schema.String,
  set: Schema.Boolean,
});

export type ProviderSecretField = Schema.Schema.Type<typeof ProviderSecretField>;

export const ProviderInstance = Schema.Struct({
  id: Id,
  providerId: Schema.String,
  name: ProviderInstanceName,
  config: Schema.Json,
  displayName: Schema.String,
  /** The harness's executable name on a machine's `PATH`, which is how Runner Facts refer to it. */
  binaryName: Schema.String,
  declared: DeclaredCapabilities,
  /** Empty where the provider's plugin marked no field secret. */
  secretFields: Schema.Array(ProviderSecretField),
  snapshots: Schema.Array(CapabilitySnapshot),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type ProviderInstance = Schema.Schema.Type<typeof ProviderInstance>;

/** The payload of `provider.create`. The config is validated against the provider's own schema. */
export const ProviderInstanceCreateInput = Schema.Struct({
  providerId: Schema.String,
  name: ProviderInstanceName,
  config: Schema.Json,
});

export type ProviderInstanceCreateInput = Schema.Schema.Type<typeof ProviderInstanceCreateInput>;

/** The payload of `provider.update`. A field left out is not changed. */
export const ProviderInstanceUpdateInput = Schema.Struct({
  name: Schema.optionalKey(ProviderInstanceName),
  config: Schema.optionalKey(Schema.Json),
});

export type ProviderInstanceUpdateInput = Schema.Schema.Type<typeof ProviderInstanceUpdateInput>;

/**
 * The machine a login runs on. A vendor credential belongs to exactly one
 * machine, because with refresh-token rotation, two live copies of one login
 * log each other out.
 */
export const ProviderLoginInput = Schema.Struct({ runnerId: Id });

export type ProviderLoginInput = Schema.Schema.Type<typeof ProviderLoginInput>;

/**
 * The code the user copied from the browser they opened the URL in. It must
 * be a single line: it is written to the vendor CLI's stdin, where a second
 * line would be read as the answer to its next question.
 */
export const ProviderLoginCodeInput = Schema.Struct({
  runnerId: Id,
  code: bounded(1, 512).check(
    Schema.isPattern(/^[^\r\n]+$/, {
      title: "code",
      description: "a single line",
    }),
  ),
});

export type ProviderLoginCodeInput = Schema.Schema.Type<typeof ProviderLoginCodeInput>;

export const provider = HttpApiGroup.make("provider")
  .add(
    HttpApiEndpoint.get("query", "/providers", {
      success: Schema.Array(ProviderInstance),
      error: [Unauthenticated, Forbidden, Internal],
    }),
    HttpApiEndpoint.get("read", "/providers/:id", {
      params: { id: Id },
      success: ProviderInstance,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("create", "/providers", {
      payload: ProviderInstanceCreateInput,
      success: ProviderInstance,
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.patch("update", "/providers/:id", {
      params: { id: Id },
      payload: ProviderInstanceUpdateInput,
      success: ProviderInstance,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.delete("delete", "/providers/:id", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("login", "/providers/:id/login", {
      params: { id: Id },
      payload: ProviderLoginInput,
      success: Schema.Struct({
        url: Schema.String,
        /** Present when the harness printed a code to type in the browser. */
        userCode: Schema.optionalKey(Schema.String),
      }),
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("submitLoginCode", "/providers/:id/login-code", {
      params: { id: Id },
      payload: ProviderLoginCodeInput,
      success: CapabilitySnapshot,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
  )
  .middleware(Authenticated);
