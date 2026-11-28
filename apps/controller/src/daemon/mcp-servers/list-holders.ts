import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { announce } from "../../db";
import { McpServerListHolders } from "../../mcp-servers";
import { ProjectService } from "../../projects";
import { sessionRepository } from "../../sessions";

/**
 * Provides the mcp-servers domain's `McpServerListHolders`. It lives in the
 * controller daemon because Projects and Sessions both depend on the
 * mcp-servers domain, so it cannot reach them without a cycle.
 *
 * `removeServer` takes the server out of every Project's list and every
 * Session's list:
 *
 * - The Project service records a `project.updated` event for each live
 *   Project that held it. Projects have no live topic, so that event is the
 *   only record of the change.
 * - Each Session that held it is announced on the `session` topic, as every
 *   change to a Session record is.
 */
export const McpServerListHoldersLayer = Layer.effect(McpServerListHolders)(
  Effect.gen(function* () {
    const projects = yield* ProjectService;
    const sessions = yield* sessionRepository;

    return {
      removeServer: (id) =>
        Effect.gen(function* () {
          yield* projects.removeMcpServer(id);
          const held = yield* sessions.removeMcpServer(id);
          yield* Effect.forEach(
            held,
            (session) =>
              announce({
                _tag: "record",
                topic: "session",
                id: session.id,
                conversationId: session.conversationId,
                kind: "updated",
              }),
            { discard: true },
          );
        }),
    };
  }),
);
