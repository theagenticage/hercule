/**
 * Agents: the named, reusable configuration a session is spawned from.
 *
 * An Agent is an identity and a set of defaults, and nothing else: a prompt, a
 * provider instance, a permission profile, an access mode, a model and a list
 * of tool restrictions. It holds no state, it has no status axis, and it runs
 * nothing itself. A spawn copies every value it uses onto the Session and
 * never reads back through the Agent afterwards (ADR 0030), so an edit changes
 * only the sessions spawned after the edit.
 *
 * `unenforced` reports what a provider will ignore. A provider may store a
 * spec field it does not act on, and the record names that field, so the
 * caller does not learn it from the harness's behaviour.
 */
import { Schema } from "effect";
import { AccessMode, DisallowedTool, ModelSelection } from "@hercule/protocol";
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
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { bounded } from "../strings";

/** The tool vocabulary is the protocol's; the API hands it out unchanged. */
export { DisallowedTool };

/** The longest agent name. */
const MAX_AGENT_NAME_LENGTH = 128;

/** The longest system prompt. The prompt travels on the `SessionSpec`. */
const MAX_SYSTEM_PROMPT_LENGTH = 64 * 1024;

const AgentName = bounded(1, MAX_AGENT_NAME_LENGTH);

const SystemPrompt = bounded(1, MAX_SYSTEM_PROMPT_LENGTH);

/** The model a session opens on, by the slug its provider instance lists. */
const ModelSlug = Schema.NonEmptyString;

/**
 * A field of a session's spec the provider stores but does not act on, read
 * from the provider instance's declared capabilities at every read.
 */
export const UnenforcedSpecField = Schema.Literals(["disallowedTools"]);

export type UnenforcedSpecField = Schema.Schema.Type<typeof UnenforcedSpecField>;

export const Agent = Schema.Struct({
  id: Id,
  name: AgentName,
  /** Appended to the harness's own system prompt on every session spawned from this agent. */
  systemPrompt: SystemPrompt,
  instanceId: Id,
  /** The Permission Profile every session spawned from this agent carries. */
  permissionProfileId: Id,
  /** What its sessions may do unasked; agents work unattended, so the default is full access. */
  accessMode: AccessMode,
  /** `null` runs on whatever model the instance offers by default. */
  model: Schema.NullOr(ModelSelection),
  disallowedTools: Schema.Array(DisallowedTool),
  /** Which of the fields above this agent's provider ignores; usually empty. */
  unenforced: Schema.Array(UnenforcedSpecField),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type Agent = Schema.Schema.Type<typeof Agent>;

/** What an agent listing may be sorted by. */
export const AGENT_SORT_FIELDS = ["createdAt"] as const;

/**
 * What creating an agent takes. The model and its options are two fields here
 * and one `ModelSelection` on the record. A choice belongs to the model that
 * offers it, so `options` may only be named beside a `model`, and the service
 * folds the two into the selection it stores. Every other command spells a
 * model the same way: `--model <slug> --options <json>`.
 */
export const AgentCreateInput = Schema.Struct({
  name: AgentName,
  systemPrompt: SystemPrompt,
  instanceId: Id,
  permissionProfileId: Id,
  accessMode: Schema.optionalKey(AccessMode),
  /** Absent runs its sessions on whatever the instance offers by default. */
  model: Schema.optionalKey(ModelSlug),
  /** The choices that model opens with. Refused if no `model` is beside them. */
  options: Schema.optionalKey(ModelSelection.fields.options),
  disallowedTools: Schema.optionalKey(Schema.Array(DisallowedTool)),
});

export type AgentCreateInput = Schema.Schema.Type<typeof AgentCreateInput>;

/** What editing an agent takes. An absent field is left as it was. */
export const AgentUpdateInput = Schema.Struct({
  name: Schema.optionalKey(AgentName),
  systemPrompt: Schema.optionalKey(SystemPrompt),
  instanceId: Schema.optionalKey(Id),
  permissionProfileId: Schema.optionalKey(Id),
  accessMode: Schema.optionalKey(AccessMode),
  /**
   * `null` puts the agent back on the instance's default model. A model named
   * here replaces the stored choices with the `options` beside it, or with no
   * choices at all, because the stored choices belonged to the old model.
   */
  model: Schema.optionalKey(Schema.NullOr(ModelSlug)),
  /** The choices of the model named beside them. Options alone are refused. */
  options: Schema.optionalKey(ModelSelection.fields.options),
  disallowedTools: Schema.optionalKey(Schema.Array(DisallowedTool)),
});

export type AgentUpdateInput = Schema.Schema.Type<typeof AgentUpdateInput>;

/**
 * What an agent listing may be narrowed by. The profile is the one field:
 * deleting a Permission Profile is refused while an Agent names it, and the
 * caller has to be able to find that Agent.
 */
export const AgentFilter = Schema.Struct({
  /** Only the Agents that spawn their sessions under this Permission Profile. */
  permissionProfileId: Schema.optionalKey(Id),
});

export const agent = HttpApiGroup.make("agent")
  .add(
    HttpApiEndpoint.get("query", "/agents", {
      query: Schema.Struct({
        ...AgentFilter.fields,
        ...pageParams(AGENT_SORT_FIELDS).fields,
      }),
      success: page(Agent),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.get("read", "/agents/:id", {
      params: { id: Id },
      success: Agent,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("create", "/agents", {
      payload: AgentCreateInput,
      success: Agent,
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.patch("update", "/agents/:id", {
      params: { id: Id },
      payload: AgentUpdateInput,
      success: Agent,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.delete("delete", "/agents/:id", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
  )
  .middleware(Authenticated);
