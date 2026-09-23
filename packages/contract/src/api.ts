/**
 * The public API: one HttpApi declaration, prefixed `/api/v1`.
 *
 * Groups are named for the entity family; an endpoint's identifier is the
 * operation's verb, so `<group>.<endpoint>` is the operation id verbatim and
 * the route table in `operations.ts` can be looked up from a request without a
 * second naming scheme.
 */
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import { API_PREFIX } from "./operations";
import { agent } from "./groups/agent";
import { apiKey } from "./groups/api-key";
import { auth } from "./groups/auth";
import { connection } from "./groups/connection";
import { controller } from "./groups/controller";
import { event } from "./groups/event";
import { eventKind } from "./groups/event-kind";
import { input } from "./groups/input";
import { plugin } from "./groups/plugin";
import { profile } from "./groups/profile";
import { provider } from "./groups/provider";
import { project } from "./groups/project";
import { resource } from "./groups/resource";
import { runner } from "./groups/runner";
import { secret } from "./groups/secret";
import { session } from "./groups/session";
import { settings } from "./groups/settings";
import { setup } from "./groups/setup";
import { subscription } from "./groups/subscription";
import { task } from "./groups/task";
import { transcript } from "./groups/transcript";
import { trigger } from "./groups/trigger";
import { user } from "./groups/user";
import { workflow } from "./groups/workflow";
import { workflowAction } from "./groups/workflow-action";
import { workspace } from "./groups/workspace";

export const api = HttpApi.make("hercule")
  .add(
    setup,
    auth,
    apiKey,
    user,
    settings,
    profile,
    secret,
    task,
    project,
    resource,
    workspace,
    event,
    subscription,
    workflow,
    trigger,
    workflowAction,
    eventKind,
    runner,
    plugin,
    provider,
    connection,
    agent,
    session,
    input,
    transcript,
    controller,
  )
  .prefix(API_PREFIX);
