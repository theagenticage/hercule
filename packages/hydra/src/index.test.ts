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

  it("sends runner join-token create to the CLI", async () => {
    await dispatch(["runner", "join-token", "create"]);
    expect(run.cli).toHaveBeenCalledWith(["runner", "join-token", "create"]);
    expect(run.runner).not.toHaveBeenCalled();
  });

  // `runner --help` is the one flag-shaped subcommand the runner role does not
  // own: what it documents is the CLI's noun as much as the daemon.
  it("sends runner --help and runner -h to the CLI", async () => {
    await dispatch(["runner", "--help"]);
    expect(run.cli).toHaveBeenCalledWith(["runner", "--help"]);
    expect(run.runner).not.toHaveBeenCalled();

    await dispatch(["runner", "-h"]);
    expect(run.cli).toHaveBeenCalledWith(["runner", "-h"]);
    expect(run.runner).not.toHaveBeenCalled();
  });

  it("sends runner set-controller to the runner, and still sends join-token create to the CLI", async () => {
    // `set-controller` rewrites the runner's own file rather than calling an
    // operation, so it belongs to the runner role beside `join`.
    await dispatch(["runner", "set-controller", "https://controller.example:8443"]);
    expect(run.runner).toHaveBeenCalledWith(["set-controller", "https://controller.example:8443"]);
    expect(run.cli).not.toHaveBeenCalled();

    await dispatch(["runner", "join-token", "create"]);
    expect(run.cli).toHaveBeenCalledWith(["runner", "join-token", "create"]);
    expect(run.runner).toHaveBeenCalledTimes(1);
  });

  it("skips leading global options before matching the verb", async () => {
    await dispatch(["--home", "/tmp/h", "serve"]);
    expect(run.controller).toHaveBeenCalledWith(["--home", "/tmp/h"]);
    await dispatch(["--home", "/tmp/h", "--version"]);
    expect(run.cli).not.toHaveBeenCalled();
  });

  it("skips the glued form of --home too", async () => {
    await dispatch(["--home=/tmp/h", "serve"]);
    expect(run.controller).toHaveBeenCalledWith(["--home=/tmp/h"]);
    await dispatch(["-c", "bind.port=1", "--home=/tmp/h", "-c", "log.level=debug", "serve"]);
    expect(run.controller).toHaveBeenCalledWith([
      "-c",
      "bind.port=1",
      "--home=/tmp/h",
      "-c",
      "log.level=debug",
    ]);
    await dispatch(["--home=/tmp/h", "--version"]);
    expect(run.cli).not.toHaveBeenCalled();
  });

  it("sends everything else to the CLI", async () => {
    await dispatch(["task", "list"]);
    expect(run.cli).toHaveBeenCalledWith(["task", "list"]);
  });

  it("starts no role when a global option is malformed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await dispatch(["serve", "--home"]);
    expect(String(error.mock.calls[0]?.[0])).toContain("directory");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    error.mockRestore();
    expect(run.controller).not.toHaveBeenCalled();
    expect(run.cli).not.toHaveBeenCalled();
  });

  it("propagates a rejection from the role it started", async () => {
    run.cli.mockRejectedValueOnce(new Error("boom"));
    await expect(dispatch(["task", "list"])).rejects.toThrow("boom");
  });
});
