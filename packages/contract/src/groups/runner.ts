/**
 * Runners: the daemons that host sessions on the controller's behalf.
 *
 * Almost everything a runner row holds is reported by the runner itself over
 * the runner protocol - its state, the version of the binary it runs, the
 * capabilities the two ends negotiated, the facts it probed and the watermark
 * it keeps refreshing. None of that is writable here: a patch may set the name,
 * the labels and the session cap, and nothing else.
 *
 * The reported fields are nullable rather than absent, because a runner that
 * has never connected still has them - it has not said what they are yet. A
 * client rendering the fleet then reads one shape whichever runner it is
 * looking at.
 */
import { Schema } from "effect";
import { Capabilities, Fact, RunnerFacts, RunnerWatermark } from "@hydra/protocol";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import { closedStruct } from "../closed";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { Id, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { atMost, bounded } from "../strings";

/**
 * The runner's own report of itself, as it reaches the controller. The
 * controller stores a report whole and hands it back here, so the public shape
 * is the wire shape rather than a copy of it that can drift out of step.
 */
export {
  Capabilities as RunnerCapabilities,
  ProviderBinary as RunnerProvider,
  RunnerFacts,
  RunnerWatermark,
  Toolchain as RunnerToolchain,
} from "@hydra/protocol";

/** The longest runner name. A name is what the fleet list shows, not a note. */
export const MAX_RUNNER_NAME_LENGTH = 128;

/** The longest runner label. */
export const MAX_RUNNER_LABEL_LENGTH = 64;

/**
 * The most labels one runner carries. Labels are placement filters and nothing
 * more, and they are replaced whole by every write, so one generous bound is
 * enough; far more than anyone reads at a glance.
 */
export const MAX_RUNNER_LABELS = 64;

/** The five states a runner is in. Only the protocol moves a runner between them. */
export const RUNNER_STATES = ["online", "offline", "unreachable", "draining", "retired"] as const;

export const RunnerState = Schema.Literals(RUNNER_STATES);

export type RunnerState = Schema.Schema.Type<typeof RunnerState>;

const RunnerName = bounded(1, MAX_RUNNER_NAME_LENGTH);

const RunnerLabel = bounded(1, MAX_RUNNER_LABEL_LENGTH);

/** A runner as the fleet list shows it. */
export const Runner = Schema.Struct({
  id: Id,
  name: RunnerName,
  state: RunnerState,
  /** The version of the Hydra binary the runner runs; null until it says. */
  version: Schema.NullOr(Fact),
  labels: atMost(RunnerLabel, MAX_RUNNER_LABELS),
  facts: Schema.NullOr(RunnerFacts),
  watermark: Schema.NullOr(RunnerWatermark),
  maxConcurrentSessions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** When the runner was last heard from; null until it connects the first time. */
  lastSeenAt: Schema.NullOr(Timestamp),
});

export type Runner = Schema.Schema.Type<typeof Runner>;

/**
 * One runner in full: the list's fields plus what the hello negotiated.
 *
 * `negotiatedCapabilities` is spelled out because a Runner Capability is
 * something else - a probed toolchain or a user-applied label, both of which
 * sit in the fields beside it. This list is what the two protocol ends agreed
 * to speak, and it is bounded like the reported lists because it comes off the
 * same wire and through the same hello.
 */
export const RunnerDetail = Schema.Struct({
  ...Runner.fields,
  negotiatedCapabilities: Schema.NullOr(Capabilities),
  protocolVersion: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});

export type RunnerDetail = Schema.Schema.Type<typeof RunnerDetail>;

/** What narrows a fleet listing: one state, one label, and both. */
export const RunnerFilter = Schema.Struct({
  state: Schema.optionalKey(RunnerState),
  label: Schema.optionalKey(RunnerLabel),
});

/** What a fleet listing may be sorted by. A fleet is read by name. */
export const RUNNER_SORT_FIELDS = ["name"] as const;

/**
 * The three fields of a runner a person owns. Declared apart from the payload
 * below so a service can spread them beside the runner id and hold an
 * in-process caller to the same bounds a request is held to.
 */
export const RUNNER_EDIT_FIELDS = {
  name: Schema.optionalKey(RunnerName),
  labels: Schema.optionalKey(atMost(RunnerLabel, MAX_RUNNER_LABELS)),
  maxConcurrentSessions: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
} as const;

/**
 * What editing a runner takes. Unknown keys are refused rather than dropped, so
 * a caller who tries to write the state, the facts or the watermark is told
 * those are the runner's own to report, instead of getting a 200 that changed
 * nothing.
 */
export const RunnerUpdateInput = closedStruct(RUNNER_EDIT_FIELDS);

export type RunnerUpdateInput = Schema.Schema.Type<typeof RunnerUpdateInput>;

/**
 * A freshly minted join token. Like an API key's token it is shown here and
 * nowhere else: the controller keeps only its hash, so a token nobody wrote
 * down is a token nobody can use.
 */
export const MintedJoinToken = Schema.Struct({
  token: Schema.NonEmptyString,
  expiresAt: Timestamp,
});

export type MintedJoinToken = Schema.Schema.Type<typeof MintedJoinToken>;

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
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("createJoinToken", "/runners/join-tokens", {
      success: HttpApiSchema.status(201)(MintedJoinToken),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
  )
  .middleware(Authenticated);
