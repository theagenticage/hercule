/**
 * Provider instances: one provider definition plus the config a caller gave it.
 *
 * The instance id, not the provider id, is what everything downstream routes
 * on, because one provider can hold several accounts kept apart by their own
 * config directories. The controller opens one instance per registered provider
 * at boot, so a fresh install already has something to log in to.
 *
 * `displayName` and `declared` are facts of the definition rather than columns
 * of the row: they are composed at read from the plugin that registered the
 * provider, so a build that changes them changes every instance at once.
 */
import { Schema } from "effect";
import { DeclaredCapabilities, MAX_PROVIDER_NAME_LENGTH } from "@hydra/plugin-host";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
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

/** One model a harness offers, and the per-model choices the composer renders. */
export const ModelDescriptor = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  isDefault: Schema.optionalKey(Schema.Boolean),
  isLegacy: Schema.optionalKey(Schema.Boolean),
  options: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      kind: Schema.Literals(["select", "boolean"]),
      choices: Schema.optionalKey(
        Schema.Array(Schema.Struct({ value: Schema.String, label: Schema.String })),
      ),
      default: Schema.Union([Schema.String, Schema.Boolean]),
    }),
  ),
});

export type ModelDescriptor = Schema.Schema.Type<typeof ModelDescriptor>;

/** Whether the harness reports a usable login, and who it belongs to. */
export const SnapshotAuth = Schema.Struct({
  status: Schema.Literals(["ok", "unauthenticated", "error"]),
  identity: Schema.optionalKey(Schema.String),
  planLabel: Schema.optionalKey(Schema.String),
  backend: Schema.optionalKey(Schema.String),
  /** Why the probe failed, so an `error` is something the user can act on. */
  message: Schema.optionalKey(Schema.String),
});

export type SnapshotAuth = Schema.Schema.Type<typeof SnapshotAuth>;

/**
 * What one runner last reported about one instance. Scope is instance x runner
 * because harness versions, logins and model catalogues differ per machine.
 */
export const CapabilitySnapshot = Schema.Struct({
  runnerId: Id,
  probedAt: Timestamp,
  harnessVersion: Schema.NullOr(Schema.String),
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
  )
  .middleware(Authenticated);
