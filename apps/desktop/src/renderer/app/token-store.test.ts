import { describe, expect, it, vi } from "vitest";
import { createDesktopTokenStore } from "./token-store";

describe("createDesktopTokenStore", () => {
  it("reads the token boot read from main", () => {
    const write = vi.fn(() => Promise.resolve(undefined));
    expect(createDesktopTokenStore("bearer", { token: { read: vi.fn(), write } }).read()).toBe(
      "bearer",
    );
  });

  it("sends each write to main, a removal included", () => {
    const write = vi.fn(() => Promise.resolve(undefined));
    const store = createDesktopTokenStore(null, { token: { read: vi.fn(), write } });
    store.write("bearer");
    store.write(null);
    expect(write.mock.calls).toEqual([["bearer"], [null]]);
  });

  it("logs a write main refuses rather than throwing it", async () => {
    const refusal = new Error("refused");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = createDesktopTokenStore(null, {
      token: { read: vi.fn(), write: () => Promise.reject(refusal) },
    });
    expect(() => {
      store.write("bearer");
    }).not.toThrow();
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith("Could not save the login token:", refusal);
    });
    logged.mockRestore();
  });
});
