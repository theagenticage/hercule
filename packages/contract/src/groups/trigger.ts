/**
 * Triggers: a workflow's rules for when events enter it, one row each.
 *
 * A trigger is written in its workflow's source, and the controller keeps a
 * row for it beside the workflow, so the triggers of every workflow can be
 * listed together: a scheduled-tasks view is a listing of the cron triggers.
 * A trigger is named by its workflow's id and by the id the source gives it,
 * which is unique only inside that workflow.
 *
 * Every field of a trigger is in the listing, so there is no read of one
 * trigger. A field the trigger does not have is absent, not null.
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
import { ConnectionSelection } from "./workflow";

/** A start trigger starts runs. A signal trigger resumes a run that is live. */
export const TriggerKind = Schema.Literals(["start", "signal"]);

export type TriggerKind = Schema.Schema.Type<typeof TriggerKind>;

/**
 * Whether a start trigger starts runs. It is state of the row and not part of
 * the source, so pausing a trigger never rewrites the text. A signal trigger
 * has no status: it cannot be paused.
 */
export const TriggerStatus = Schema.Literals(["active", "paused"]);

export type TriggerStatus = Schema.Schema.Type<typeof TriggerStatus>;

export const Trigger = Schema.Struct({
  workflowId: Id,
  /** The name the workflow's definition gives it, so a listing needs no second read. */
  workflowName: Schema.String,
  /** The id the source gives the trigger. */
  triggerId: Schema.String,
  kind: TriggerKind,
  eventKind: EventKind,
  connectionId: Schema.optionalKey(ConnectionSelection),
  filter: Schema.optionalKey(Schema.String),
  schedule: Schema.optionalKey(Schema.String),
  /** As the source writes it. A cron trigger with none is read in the user's timezone setting. */
  timezone: Schema.optionalKey(Timezone),
  /** On a start trigger only. */
  status: Schema.optionalKey(TriggerStatus),
  createdAt: Timestamp,
  /** When the trigger itself last changed, which a save of its workflow does not always do. */
  updatedAt: Timestamp,
});

export type Trigger = Schema.Schema.Type<typeof Trigger>;

/** What narrows a trigger listing. Each field narrows; there is no negation. */
export const TriggerFilter = Schema.Struct({
  workflowId: Schema.optionalKey(Id),
  kind: Schema.optionalKey(TriggerKind),
  eventKind: Schema.optionalKey(EventKind),
  status: Schema.optionalKey(TriggerStatus),
});

/** What a trigger listing may be sorted by. */
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
