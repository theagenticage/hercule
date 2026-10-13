import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * The port through which `AgentService` reports that an agent was deleted.
 * The workflows domain listens, because a stored workflow whose agent step
 * names the agent no longer validates. It is declared here and implemented
 * in the controller daemon, because the workflows domain depends on this one.
 *
 * It is called after the delete has committed, so it never fails: the
 * implementation logs its own failure.
 */
export class AgentObserver extends Context.Service<
  AgentObserver,
  {
    /** Reports that an agent was deleted. */
    readonly agentDeleted: () => Effect.Effect<void>;
  }
>()("hercule/controller/agents/AgentObserver") {}
