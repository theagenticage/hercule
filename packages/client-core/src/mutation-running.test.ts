import { describe, expect, it } from "vitest";
import { MutationObserver, QueryClient } from "@tanstack/query-core";
import { isAnswerSendRunning, isMutationRunning } from "./mutation-running";

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

describe("isAnswerSendRunning", () => {
  it("is true only while a mutation under the key runs for that request", async () => {
    const queryClient = new QueryClient();
    let finish = (): void => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const observer = new MutationObserver<void, Error, unknown>(queryClient, {
      mutationKey: ["answer"],
      mutationFn: () => finished,
    });
    expect(isAnswerSendRunning(queryClient, ["answer"], "req-1")).toBe(false);

    const sent = observer.mutate({ requestId: "req-1", answers: {} });
    expect(isAnswerSendRunning(queryClient, ["answer"], "req-1")).toBe(true);
    expect(isAnswerSendRunning(queryClient, ["answer"], "req-2")).toBe(false);
    expect(isAnswerSendRunning(queryClient, ["other"], "req-1")).toBe(false);

    finish();
    await sent;
    expect(isAnswerSendRunning(queryClient, ["answer"], "req-1")).toBe(false);
  });

  it("is false for a running mutation whose variables carry no request id", () => {
    const queryClient = new QueryClient();
    const observer = new MutationObserver<void, Error, unknown>(queryClient, {
      mutationKey: ["answer"],
      mutationFn: () => new Promise<void>(() => {}),
    });

    void observer.mutate("req-1");
    void observer.mutate(null);
    void observer.mutate({ requestId: 1 });

    expect(isAnswerSendRunning(queryClient, ["answer"], "req-1")).toBe(false);
  });
});
