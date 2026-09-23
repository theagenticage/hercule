import { describe, expect, it, vi } from "vitest";
import { spawnOwnBinary } from "./spawn";

const spawn = vi.hoisted(() => vi.fn(() => ({ pid: 1 })));
vi.mock("node:child_process", () => ({ spawn }));

describe("spawnOwnBinary", () => {
  it("re-executes this binary, never a literal bun", () => {
    spawnOwnBinary(["runner", "--local"]);
    expect(spawn).toHaveBeenCalledWith(process.execPath, ["runner", "--local"], {
      stdio: "inherit",
    });
  });
});
