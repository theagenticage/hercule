import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { buildQueryKeys, type HerculeClient } from "@hercule/client-core";
import { invalidateForPush } from "../../../app/live";
import { askMergeCheck } from "./-merge-check";

/** A client whose merge check answers with `refusal`, or allows the merge when there is none. */
const buildClient = (answers: readonly (string | undefined)[]) => {
  const checkMerge = vi.fn();
  for (const refusal of answers) {
    checkMerge.mockResolvedValueOnce(refusal === undefined ? {} : { refusal });
  }
  return { checkMerge, client: { task: { checkMerge } } as unknown as HerculeClient };
};

/** Delivers a `task` push to the cache the way the live connection does. */
const pushTask = (queryClient: QueryClient, derived: true | undefined): void => {
  invalidateForPush(queryClient, "task", buildQueryKeys("task", ["t1"], undefined, derived), {
    ids: ["t1"],
    kind: "updated",
  });
};

describe("asking whether a merge would be refused", () => {
  it("asks once for the same pair within a few seconds", async () => {
    const queryClient = new QueryClient();
    const { checkMerge, client } = buildClient([undefined]);

    await askMergeCheck(queryClient, client, "a", "b");
    await askMergeCheck(queryClient, client, "a", "b");

    expect(checkMerge).toHaveBeenCalledOnce();
  });

  it.each([undefined, true] as const)(
    "asks again after a task push (derived: %s), so a removed blocker no longer refuses",
    async (derived) => {
      const queryClient = new QueryClient();
      const { checkMerge, client } = buildClient(["B already waits on A.", undefined]);
      expect(await askMergeCheck(queryClient, client, "a", "b")).toEqual({
        kind: "refused",
        refusal: "B already waits on A.",
      });

      pushTask(queryClient, derived);

      expect(await askMergeCheck(queryClient, client, "a", "b")).toEqual({ kind: "allowed" });
      expect(checkMerge).toHaveBeenCalledTimes(2);
    },
  );

  it("does not ask by itself when a push marks an answer out of date", async () => {
    const queryClient = new QueryClient();
    const { checkMerge, client } = buildClient([undefined]);
    await askMergeCheck(queryClient, client, "a", "b");

    pushTask(queryClient, undefined);
    await Promise.resolve();

    expect(checkMerge).toHaveBeenCalledOnce();
  });

  it("answers unchecked, which is no approval, when the question fails", async () => {
    const checkMerge = vi.fn().mockRejectedValue(new Error("offline"));
    const client = { task: { checkMerge } } as unknown as HerculeClient;

    expect(await askMergeCheck(new QueryClient(), client, "a", "b")).toEqual({
      kind: "unchecked",
    });
  });
});
