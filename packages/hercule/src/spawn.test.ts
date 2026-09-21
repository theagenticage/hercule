import { describe, expect, it, vi } from "vitest";
import { spawnHercule } from "./spawn";

const spawn = vi.hoisted(() => vi.fn(() => ({ pid: 1 })));
vi.mock("node:child_process", () => ({ spawn }));

describe("spawnHercule", () => {
  it("re-executes this binary, never a literal bun", () => {
    spawnHercule(["runner", "--local"]);
    expect(spawn).toHaveBeenCalledWith(process.execPath, ["runner", "--local"], {
      stdio: "inherit",
    });
  });
});
