/**
 * The instance id, not the provider id, is what everything routes on: one
 * provider can hold several accounts kept apart by their config directories.
 * `displayName`, `binaryName` and `declared` come from the registering plugin
 * at read time, not from the stored row.
 */
import { Schema } from "effect";
import { DeclaredCapabilities, MAX_PROVIDER_NAME_LENGTH } from "@hydra/plugin-host";
import { ModelDescriptor, SnapshotAuth } from "@hydra/protocol";
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
 * The longest name a provider instance may carry. It is the provider's own
 * bound because the controller names an instance after its provider.
 */
export const MAX_PROVIDER_INSTANCE_NAME_LENGTH = MAX_PROVIDER_NAME_LENGTH;

const ProviderInstanceName = bounded(1, MAX_PROVIDER_INSTANCE_NAME_LENGTH);

/** Re-exported so a reader of an instance needs only this package. */
export { DeclaredCapabilities } from "@hydra/plugin-host";

/** Re-exported rather than copied, so the public shape cannot drift from the wire shape. */
export { ModelDescriptor, ModelOption, SnapshotAuth } from "@hydra/protocol";

/**
 * How the harness version a runner reported stands against the version this
 * build was tested with. `unknown` is a machine that reported nothing, or a
 * provider nobody has pinned a floor for.
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

export const ProviderInstance = Schema.Struct({
  id: Id,
  providerId: Schema.String,
  name: ProviderInstanceName,
  config: Schema.Json,
  displayName: Schema.String,
  /** The harness's name on a machine's `PATH`, which is how facts name it. */
  binaryName: Schema.String,
  declared: DeclaredCapabilities,
  snapshots: Schema.Array(CapabilitySnapshot),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type ProviderInstance = Schema.Schema.Type<typeof ProviderInstance>;

/** What opening an instance takes. The config is read against the provider's own schema. */
export const ProviderInstanceCreateInput = Schema.Struct({
  providerId: Schema.String,
  name: ProviderInstanceName,
  config: Schema.Json,
});

export type ProviderInstanceCreateInput = Schema.Schema.Type<typeof ProviderInstanceCreateInput>;

/** What editing an instance takes. An absent field is left as it was. */
export const ProviderInstanceUpdateInput = Schema.Struct({
  name: Schema.optionalKey(ProviderInstanceName),
  config: Schema.optionalKey(Schema.Json),
});

export type ProviderInstanceUpdateInput = Schema.Schema.Type<typeof ProviderInstanceUpdateInput>;

/**
 * Which machine a login runs on. A vendor credential belongs to exactly one
 * machine, because refresh-token rotation makes two live copies of one log each
 * other out.
 */
export const ProviderLoginInput = Schema.Struct({ runnerId: Id });

export type ProviderLoginInput = Schema.Schema.Type<typeof ProviderLoginInput>;

/**
 * The code the user pasted back out of the browser they opened the URL in. One
 * line by construction: it is written to the vendor's stdin, where a second
 * line would be read as a second answer to whatever it asks next.
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
      success: Schema.Struct({ url: Schema.String }),
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
