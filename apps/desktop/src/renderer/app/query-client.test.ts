import { afterEach, describe, expect, it, vi } from "vitest";
import { onlineManager } from "@tanstack/react-query";
import { createQueryClient } from "./query-client";

afterEach(() => {
  onlineManager.setOnline(true);
});

describe("createQueryClient", () => {
  it("reads and writes while Chromium reports the Mac offline", async () => {
    onlineManager.setOnline(false);
    const queryClient = createQueryClient();

    const key = ["read offline"];
    void queryClient.fetchQuery({ queryKey: key, queryFn: () => Promise.resolve("read") });
    const mutation = queryClient
      .getMutationCache()
      .build(queryClient, { mutationFn: () => Promise.resolve("written") });
    void mutation.execute(undefined);

    // A paused read or write would stay pending here.
    await vi.waitFor(() => {
      expect(queryClient.getQueryData(key)).toBe("read");
      expect(mutation.state.data).toBe("written");
    });
  });
});
