import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * The port through which `AgentService` reports that an agent was deleted, or
 * that the harness an agent runs in changed. The workflows domain listens,
 * because a stored workflow whose agent step names the agent may stop
 * validating (the agent is gone, or its harness can no longer give the
 * structured result the step asks for) or start validating again. It is
 * declared here and implemented in the controller daemon, because the
 * workflows domain depends on this one.
 *
 * It is called after the change has committed, so it never fails: the
 * implementation logs its own failure.
 */
export class AgentObserver extends Context.Service<
  AgentObserver,
  {
    /** Reports that an agent was deleted. */
    readonly agentDeleted: () => Effect.Effect<void>;
    /** Reports that the harness an agent runs in changed. */
    readonly agentHarnessChanged: () => Effect.Effect<void>;
  }
>()("hercule/controller/agents/AgentObserver") {}
