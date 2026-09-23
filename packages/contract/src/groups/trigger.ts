/**
 * Triggers: the parts of a workflow that decide which events start a run or
 * resume one.
 *
 * A trigger is defined in its workflow's source. The controller also stores a
 * row for each trigger next to the workflow, so the triggers of all workflows
 * can be listed together. For example, a scheduled-tasks view lists the cron
 * triggers. A trigger is identified by its workflow's id plus its id in the
 * source, which is unique only within that workflow.
 *
 * The list returns every field of each trigger, so there is no operation that
 * reads one trigger. A field the trigger does not have is absent, not null.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Forbidden, Internal, Unauthenticated, Validation } from "../errors";
import { Id, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { Timezone } from "../strings";
import { EventKind } from "./event";
import { ConnectionSelection } from "./workflow-definition";

/** A start trigger starts runs. A signal trigger resumes a live run. */
export const TriggerKind = Schema.Literals(["start", "signal"]);

export type TriggerKind = Schema.Schema.Type<typeof TriggerKind>;

/**
 * Whether a start trigger starts runs. The status is stored on the trigger's
 * row, not in the source, so pausing a trigger never changes the workflow's
 * text. A signal trigger has no status, because it cannot be paused.
 */
export const TriggerStatus = Schema.Literals(["active", "paused"]);

export type TriggerStatus = Schema.Schema.Type<typeof TriggerStatus>;

export const Trigger = Schema.Struct({
  workflowId: Id,
  /** The workflow's name, included so a client can show it without reading the workflow. */
  workflowName: Schema.String,
  /** The trigger's id in the workflow's source. */
  triggerId: Schema.String,
  kind: TriggerKind,
  eventKind: EventKind,
  connectionId: Schema.optionalKey(ConnectionSelection),
  filter: Schema.optionalKey(Schema.String),
  schedule: Schema.optionalKey(Schema.String),
  /** As written in the source. A cron trigger without one uses the user's timezone setting. */
  timezone: Schema.optionalKey(Timezone),
  /** Set on start triggers only. */
  status: Schema.optionalKey(TriggerStatus),
  createdAt: Timestamp,
  /** When the trigger itself last changed. Saving its workflow does not always change it. */
  updatedAt: Timestamp,
});

export type Trigger = Schema.Schema.Type<typeof Trigger>;

/** Filters for the trigger list. Each field narrows the list; there is no negation. */
export const TriggerFilter = Schema.Struct({
  workflowId: Schema.optionalKey(Id),
  kind: Schema.optionalKey(TriggerKind),
  eventKind: Schema.optionalKey(EventKind),
  status: Schema.optionalKey(TriggerStatus),
});

/** The fields the trigger list can be sorted by. */
export const TRIGGER_SORT_FIELDS = ["createdAt"] as const;

export const trigger = HttpApiGroup.make("trigger")
  .add(
    HttpApiEndpoint.get("query", "/triggers", {
      query: Schema.Struct({
        ...TriggerFilter.fields,
        ...pageParams(TRIGGER_SORT_FIELDS).fields,
      }),
      success: page(Trigger),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
  )
  .middleware(Authenticated);
