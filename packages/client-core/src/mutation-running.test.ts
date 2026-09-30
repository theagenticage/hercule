import { describe, expect, it } from "vitest";
import { MutationObserver, QueryClient } from "@tanstack/query-core";
import { isMutationRunning } from "./mutation-running";

describe("isMutationRunning", () => {
  it("is true from the moment a mutation under the key starts until it settles", async () => {
    const queryClient = new QueryClient();
    let answer = (): void => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const observer = new MutationObserver(queryClient, {
      mutationKey: ["save"],
      mutationFn: () => answered,
    });
    expect(isMutationRunning(queryClient, ["save"])).toBe(false);

    const saved = observer.mutate();
    expect(isMutationRunning(queryClient, ["save"])).toBe(true);
    expect(isMutationRunning(queryClient, ["sign-in"])).toBe(false);

    answer();
    await saved;
    expect(isMutationRunning(queryClient, ["save"])).toBe(false);
  });
});
