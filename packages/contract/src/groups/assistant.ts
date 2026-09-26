/**
 * Assistants: agents the user talks to through conversations.
 *
 * An assistant is an Agent with three more things: a heartbeat that wakes it
 * on a schedule, a rotation that decides when its conversation moves to a
 * fresh session, and a reply mode that decides which of its words reach the
 * conversation. Its id is the id of its Agent, so a session an assistant runs names
 * the assistant as its `agentId`.
 *
 * Every field but `name` is optional on create: the server fills in a
 * default for each one left out, so a person or an agent can create an
 * assistant from a name alone.
 */
import { Schema } from "effect";
import * as Cron from "effect/Cron";
import * as Result from "effect/Result";
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
import { Id } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { Timezone } from "../strings";
import { Agent, AgentCreateInput, AgentUpdateInput } from "./agent";
import { Prompt } from "./session";
import { TimeOfDay } from "./settings";

/**
 * A cron expression with five fields: minute, hour, day of the month, month
 * and day of the week. The parser also accepts a sixth field for seconds,
 * which is refused, because a heartbeat every second would start a turn every
 * second.
 */
const CronExpression = Schema.String.check(
  Schema.makeFilter((text: string) =>
    text.trim().split(/\s+/).length === 5 && Result.isSuccess(Cron.parse(text))
      ? undefined
      : `${text} is not a cron expression with five fields; write one such as "0 9 * * 1-5" for 09:00 on weekdays`,
  ),
);

/** When an assistant wakes by itself, and what it is told when it does. */
export const Heartbeat = Schema.Struct({
  enabled: Schema.Boolean,
  schedule: CronExpression,
  /** The zone `schedule` is read in. When absent, the user's timezone setting applies. */
  timezone: Schema.optionalKey(Timezone),
  /** The text the assistant is given at each heartbeat. */
  prompt: Prompt,
  /** Where a heartbeat's reply goes. The web channel is the only one so far. */
  target: Schema.Literal("web"),
});

export type Heartbeat = Schema.Schema.Type<typeof Heartbeat>;

/** When an assistant's conversation moves on to a fresh session. */
export const Rotation = Schema.Struct({
  /** The share of the context window that, once used, starts a fresh session. */
  contextFraction: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1)),
  /** The largest context, in tokens, a session may grow to before a fresh one starts. */
  maxContextTokens: Schema.Int.check(Schema.isGreaterThan(0)),
  /** The time of day a fresh session starts anyway, `HH:MM` on a 24-hour clock. */
  dailyAt: TimeOfDay,
  /** The zone `dailyAt` is read in. When absent, the user's timezone setting applies. */
  timezone: Schema.optionalKey(Timezone),
});

export type Rotation = Schema.Schema.Type<typeof Rotation>;

/**
 * Which of an assistant's words reach the conversation: only the last text of each
 * turn (`turn-end`), or every text it writes as the turn goes (`segments`).
 */
export const AssistantReply = Schema.Literals(["turn-end", "segments"]);

export type AssistantReply = Schema.Schema.Type<typeof AssistantReply>;

/** An assistant: every Agent field, plus how it wakes, rotates and replies. */
export const Assistant = Schema.Struct({
  ...Agent.fields,
  heartbeat: Heartbeat,
  rotation: Rotation,
  reply: AssistantReply,
});

export type Assistant = Schema.Schema.Type<typeof Assistant>;

/** What an assistant listing may be sorted by. */
export const ASSISTANT_SORT_FIELDS = ["createdAt"] as const;

/**
 * The payload of `assistant.create`. Only `name` is required; every other
 * field takes the server's default when it is left out. The model and its
 * options are taken as `agent.create` takes them.
 */
export const AssistantCreateInput = Schema.Struct({
  ...AgentCreateInput.fields,
  systemPrompt: Schema.optionalKey(AgentCreateInput.fields.systemPrompt),
  instanceId: Schema.optionalKey(AgentCreateInput.fields.instanceId),
  permissionProfileId: Schema.optionalKey(AgentCreateInput.fields.permissionProfileId),
  heartbeat: Schema.optionalKey(Heartbeat),
  rotation: Schema.optionalKey(Rotation),
  reply: Schema.optionalKey(AssistantReply),
});

export type AssistantCreateInput = Schema.Schema.Type<typeof AssistantCreateInput>;

/** The payload of `assistant.update`. A field left out is not changed. */
export const AssistantUpdateInput = Schema.Struct({
  ...AgentUpdateInput.fields,
  heartbeat: Schema.optionalKey(Heartbeat),
  rotation: Schema.optionalKey(Rotation),
  reply: Schema.optionalKey(AssistantReply),
});

export type AssistantUpdateInput = Schema.Schema.Type<typeof AssistantUpdateInput>;

export const assistant = HttpApiGroup.make("assistant")
  .add(
    HttpApiEndpoint.get("query", "/assistants", {
      query: pageParams(ASSISTANT_SORT_FIELDS),
      success: page(Assistant),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.get("read", "/assistants/:id", {
      params: { id: Id },
      success: Assistant,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("create", "/assistants", {
      payload: AssistantCreateInput,
      success: Assistant,
      error: [Unauthenticated, Forbidden, Validation, InvalidState, Internal],
    }),
    HttpApiEndpoint.patch("update", "/assistants/:id", {
      params: { id: Id },
      payload: AssistantUpdateInput,
      success: Assistant,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.delete("delete", "/assistants/:id", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
  )
  .middleware(Authenticated);
