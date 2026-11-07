/**
 * Tests the movers a screen that does not draw the Work board uses for Undo:
 * what they send, and that the move they send cannot land on the survivor of
 * a merge.
 */
import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import { buildBoard, buildCard } from "@hercule/client-core/work/testing";
import { buildCachedCardMover } from "./card-mover";

/** Builds a client whose `task.move` records what it is sent. */
const buildClient = () => {
  const move = vi.fn(() => Promise.resolve({}));
  return { move, client: { task: { move } } as unknown as HerculeClient };
};

describe("buildCachedCardMover", () => {
  it("sends a move that refuses a Task merged away since the gesture, never the survivor", async () => {
    const { move, client } = buildClient();
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      queryKeys.workBoard(),
      buildBoard(buildCard("a", { stage: "building" }), buildCard("b", { stage: "planned" })),
    );

    const put = buildCachedCardMover(client, queryClient)(
      { taskId: "a", stage: "planned", projectId: null, afterTaskId: null },
      Promise.resolve(true),
    );
    await put!.request;

    expect(move).toHaveBeenCalledExactlyOnceWith({
      params: { id: "a" },
      payload: { stage: "planned", projectId: null, afterTaskId: null, refuseIfMerged: true },
    });
  });
});
