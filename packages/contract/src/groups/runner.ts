/**
 * Runners: the daemons that host sessions on the controller's behalf.
 *
 * Almost everything a runner row holds is reported by the runner itself, and
 * none of that can be written here: a patch sets the name, the labels, the
 * session cap, the disk watermark and whether the machine is reserved, and
 * nothing else.
 *
 * The reported fields are nullable rather than absent, so a client renders one
 * shape whichever runner it is looking at.
 */
import { Schema } from "effect";
import { Capabilities, Fact, RunnerFacts, RunnerWatermark } from "@hercule/protocol";
import { CapabilitySnapshot } from "./provider";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import { closedStruct } from "../closed";
import {
  Conflict,
  Forbidden,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "../errors";
import { Id, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { atMost, bounded } from "../strings";

/**
 * The controller stores a runner's report whole and returns it here, so the
 * public shape is the runner protocol's shape rather than a copy that could
 * drift out of step.
 */
export {
  Capabilities as RunnerCapabilities,
  ProviderBinary as RunnerProvider,
  RunnerFacts,
  RunnerWatermark,
  Toolchain as RunnerToolchain,
} from "@hercule/protocol";

/** The longest runner name. A name is what the fleet list shows, not a note. */
export const MAX_RUNNER_NAME_LENGTH = 128;

export const MAX_RUNNER_LABEL_LENGTH = 64;

/** Labels are placement filters, replaced whole, so one generous bound is enough. */
export const MAX_RUNNER_LABELS = 64;

/**
 * Whether the controller can reach the machine. Only the runner's connection
 * sets it.
 */
const RUNNER_CONNECTIVITIES = ["online", "offline", "unreachable"] as const;

export const RunnerConnectivity = Schema.Literals(RUNNER_CONNECTIVITIES);

export type RunnerConnectivity = Schema.Schema.Type<typeof RunnerConnectivity>;

/**
 * The machine's lifecycle state, which only the user's operations set.
 * Connectivity and lifecycle change independently: a runner being drained is
 * exactly the one whose connectivity somebody is watching.
 */
const RUNNER_LIFECYCLES = ["active", "draining", "retired"] as const;

export const RunnerLifecycle = Schema.Literals(RUNNER_LIFECYCLES);

export type RunnerLifecycle = Schema.Schema.Type<typeof RunnerLifecycle>;

const RunnerName = bounded(1, MAX_RUNNER_NAME_LENGTH);

const RunnerLabel = bounded(1, MAX_RUNNER_LABEL_LENGTH);

export const Runner = Schema.Struct({
  id: Id,
  name: RunnerName,
  connectivity: RunnerConnectivity,
  lifecycle: RunnerLifecycle,
  /** When true, the runner only runs work that asks for it by id. */
  reserved: Schema.Boolean,
  version: Schema.NullOr(Fact),
  labels: atMost(RunnerLabel, MAX_RUNNER_LABELS),
  facts: Schema.NullOr(RunnerFacts),
  watermark: Schema.NullOr(RunnerWatermark),
  /** The effective cap: the owner's override, or the one derived from the facts. */
  maxConcurrentSessions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** The effective watermark: the owner's override, or the shipped ten gibibytes. */
  diskWatermarkBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  lastSeenAt: Schema.NullOr(Timestamp),
});

export type Runner = Schema.Schema.Type<typeof Runner>;

/**
 * The field is called `negotiatedCapabilities` rather than `capabilities`,
 * because a Runner Capability is something else: a probed toolchain or a
 * user-applied label, both of which are in the fields next to it.
 */
export const RunnerDetail = Schema.Struct({
  ...Runner.fields,
  negotiatedCapabilities: Schema.NullOr(Capabilities),
  protocolVersion: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});

export type RunnerDetail = Schema.Schema.Type<typeof RunnerDetail>;

export const RunnerFilter = Schema.Struct({
  connectivity: Schema.optionalKey(RunnerConnectivity),
  lifecycle: Schema.optionalKey(RunnerLifecycle),
  label: Schema.optionalKey(RunnerLabel),
});

/** The fleet list is sorted by name. */
export const RUNNER_SORT_FIELDS = ["name"] as const;

/**
 * Declared separately from the payload below, so a service can spread these
 * fields next to the runner id and apply the same bounds to an in-process
 * caller as to a request.
 */
export const RUNNER_EDIT_FIELDS = {
  name: Schema.optionalKey(RunnerName),
  labels: Schema.optionalKey(atMost(RunnerLabel, MAX_RUNNER_LABELS)),
  maxConcurrentSessions: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  diskWatermarkBytes: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  reserved: Schema.optionalKey(Schema.Boolean),
} as const;

/**
 * Unknown keys are rejected rather than ignored, so a caller that tries to
 * write the connectivity or the facts gets an error instead of a silent 200.
 */
export const RunnerUpdateInput = closedStruct(RUNNER_EDIT_FIELDS);

export type RunnerUpdateInput = Schema.Schema.Type<typeof RunnerUpdateInput>;

/**
 * Retiring a runner the controller cannot account for fails unless the caller
 * sets `force`: the machine may still be running sessions whose end nobody
 * can see.
 */
export const RUNNER_RETIRE_FIELDS = {
  force: Schema.optionalKey(Schema.Boolean),
} as const;

export const RunnerRetireInput = closedStruct(RUNNER_RETIRE_FIELDS);

export type RunnerRetireInput = Schema.Schema.Type<typeof RunnerRetireInput>;

/** Shown here and nowhere else: the controller keeps only its hash. */
export const MintedJoinToken = Schema.Struct({
  token: Schema.NonEmptyString,
  expiresAt: Timestamp,
});

export type MintedJoinToken = Schema.Schema.Type<typeof MintedJoinToken>;

/**
 * A join token that has not been used and has not expired, as the fleet lists
 * it. Neither the token nor its hash is included: this record shows that a
 * machine is still expected, and is not a second copy of the invitation.
 */
export const JoinTokenRef = Schema.Struct({
  id: Id,
  createdAt: Timestamp,
  expiresAt: Timestamp,
});

export type JoinTokenRef = Schema.Schema.Type<typeof JoinTokenRef>;

export const runner = HttpApiGroup.make("runner")
  .add(
    HttpApiEndpoint.get("query", "/runners", {
      query: Schema.Struct({
        ...RunnerFilter.fields,
        ...pageParams(RUNNER_SORT_FIELDS).fields,
      }),
      success: page(Runner),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.get("read", "/runners/:id", {
      params: { id: Id },
      success: RunnerDetail,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.patch("update", "/runners/:id", {
      params: { id: Id },
      payload: RunnerUpdateInput,
      success: RunnerDetail,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Conflict, Internal],
    }),
    HttpApiEndpoint.post("drain", "/runners/:id/drain", {
      params: { id: Id },
      success: RunnerDetail,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("undrain", "/runners/:id/undrain", {
      params: { id: Id },
      success: RunnerDetail,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("retire", "/runners/:id/retire", {
      params: { id: Id },
      payload: RunnerRetireInput,
      success: RunnerDetail,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("refreshFacts", "/runners/:id/refresh-facts", {
      params: { id: Id },
      success: RunnerDetail,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("probe", "/runners/:id/probe", {
      params: { id: Id },
      payload: Schema.Struct({ instanceId: Id }),
      success: CapabilitySnapshot,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("installHarness", "/runners/:id/install-harness", {
      params: { id: Id },
      payload: Schema.Struct({ providerId: Schema.String }),
      success: RunnerDetail,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("createJoinToken", "/runners/join-tokens", {
      success: HttpApiSchema.status(201)(MintedJoinToken),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    // A token is valid for an hour and machines are enrolled one at a time, so
    // all outstanding tokens are returned at once rather than paged.
    HttpApiEndpoint.get("queryJoinTokens", "/runners/join-tokens", {
      success: Schema.Array(JoinTokenRef),
      error: [Unauthenticated, Forbidden, Internal],
    }),
    HttpApiEndpoint.delete("revokeJoinToken", "/runners/join-tokens/:id", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
  )
  .middleware(Authenticated);
