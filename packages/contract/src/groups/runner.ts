/**
 * Runners: the daemons that host sessions on the controller's behalf.
 *
 * Almost everything a runner row holds is reported by the runner itself, and
 * none of that is writable here: a patch sets the name, the labels, the session
 * cap and whether the machine is reserved, and nothing else.
 *
 * The reported fields are nullable rather than absent, so a client renders one
 * shape whichever runner it is looking at.
 */
import { Schema } from "effect";
import { Capabilities, Fact, RunnerFacts, RunnerWatermark } from "@hydra/protocol";
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
 * The controller stores a runner's report whole and hands it back here, so the
 * public shape is the wire shape rather than a copy that can drift out of step.
 */
export {
  Capabilities as RunnerCapabilities,
  ProviderBinary as RunnerProvider,
  RunnerFacts,
  RunnerWatermark,
  Toolchain as RunnerToolchain,
} from "@hydra/protocol";

/** A name is what the fleet list shows, not a note. */
export const MAX_RUNNER_NAME_LENGTH = 128;

export const MAX_RUNNER_LABEL_LENGTH = 64;

/** Labels are placement filters, replaced whole, so one generous bound is enough. */
export const MAX_RUNNER_LABELS = 64;

/**
 * Whether the controller can reach the machine. Written by the socket and by
 * nobody else.
 */
const RUNNER_CONNECTIVITIES = ["online", "offline", "unreachable"] as const;

export const RunnerConnectivity = Schema.Literals(RUNNER_CONNECTIVITIES);

export type RunnerConnectivity = Schema.Schema.Type<typeof RunnerConnectivity>;

/**
 * Where the machine stands with its owner. Written by the user operations and
 * by nobody else: the two axes move independently, and a runner being drained
 * is exactly the one whose reachability somebody is watching.
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
  /** Runs only work sent to it by name. */
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
 * `negotiatedCapabilities` is spelled out because a Runner Capability is
 * something else, a probed toolchain or a user-applied label, both of which sit
 * in the fields beside it.
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

/** A fleet is read by name. */
export const RUNNER_SORT_FIELDS = ["name"] as const;

/**
 * Declared apart from the payload below so a service can spread them beside the
 * runner id and hold an in-process caller to the bounds a request is held to.
 */
export const RUNNER_EDIT_FIELDS = {
  name: Schema.optionalKey(RunnerName),
  labels: Schema.optionalKey(atMost(RunnerLabel, MAX_RUNNER_LABELS)),
  maxConcurrentSessions: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  diskWatermarkBytes: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  reserved: Schema.optionalKey(Schema.Boolean),
} as const;

/**
 * Unknown keys are refused rather than dropped, so a caller writing the
 * connectivity or the facts is told those are the runner's own instead of
 * getting a silent 200.
 */
export const RunnerUpdateInput = closedStruct(RUNNER_EDIT_FIELDS);

export type RunnerUpdateInput = Schema.Schema.Type<typeof RunnerUpdateInput>;

/**
 * Retiring a runner the controller cannot account for is refused unless the
 * caller says to do it anyway: the machine may still be running sessions
 * nobody can see the end of.
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
 * A minted token that has not been spent and has not run out, as the fleet
 * lists it. Neither the token nor its hash is here: this is what says a machine
 * is still expected, not a second copy of the invitation.
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
    // A token lives an hour and a fleet is enlisted one machine at a time, so
    // the whole outstanding set is one answer rather than a page.
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
