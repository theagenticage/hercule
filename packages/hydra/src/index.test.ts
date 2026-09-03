import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch, VERSION } from "./index";

const run = vi.hoisted(() => ({ controller: vi.fn(), runner: vi.fn(), cli: vi.fn() }));
vi.mock("@hydra/controller", () => ({ run: run.controller }));
vi.mock("@hydra/runner", () => ({ run: run.runner }));
vi.mock("@hydra/cli", () => ({ run: run.cli }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dispatch", () => {
  it("prints the version and starts no role", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await dispatch(["--version"]);
    expect(log).toHaveBeenCalledWith(VERSION);
    log.mockRestore();
    expect(run.controller).not.toHaveBeenCalled();
    expect(run.runner).not.toHaveBeenCalled();
    expect(run.cli).not.toHaveBeenCalled();
  });

  it("sends serve to the controller", async () => {
    await dispatch(["serve"]);
    expect(run.controller).toHaveBeenCalledWith([]);
  });

  it("sends the runner daemon forms to the runner", async () => {
    await dispatch(["runner"]);
    expect(run.runner).toHaveBeenCalledWith([]);
    await dispatch(["runner", "--local"]);
    expect(run.runner).toHaveBeenCalledWith(["--local"]);
  });

  it("sends runner create-join-token to the CLI", async () => {
    await dispatch(["runner", "create-join-token"]);
    expect(run.cli).toHaveBeenCalledWith(["runner", "create-join-token"]);
    expect(run.runner).not.toHaveBeenCalled();
  });

  it("skips leading global options before matching the verb", async () => {
    await dispatch(["--home", "/tmp/h", "serve"]);
    expect(run.controller).toHaveBeenCalledWith(["--home", "/tmp/h"]);
    await dispatch(["--home", "/tmp/h", "--version"]);
    expect(run.cli).not.toHaveBeenCalled();
  });

  it("sends everything else to the CLI", async () => {
    await dispatch(["task", "list"]);
    expect(run.cli).toHaveBeenCalledWith(["task", "list"]);
  });

  it("propagates a rejection from the role it started", async () => {
    run.cli.mockRejectedValueOnce(new Error("boom"));
    await expect(dispatch(["task", "list"])).rejects.toThrow("boom");
  });
});
