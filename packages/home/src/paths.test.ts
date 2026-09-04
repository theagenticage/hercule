import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { homePaths, resolveHomePath } from "./paths";

describe("resolveHomePath", () => {
  it("prefers --home, then HYDRA_HOME, then ~/.hydra", () => {
    expect(resolveHomePath("/tmp/flag", { HYDRA_HOME: "/tmp/env" })).toBe("/tmp/flag");
    expect(resolveHomePath(undefined, { HYDRA_HOME: "/tmp/env" })).toBe("/tmp/env");
    expect(resolveHomePath(undefined, {})).toBe(join(homedir(), ".hydra"));
  });

  it("makes a relative home absolute", () => {
    expect(resolveHomePath("rel", {})).toBe(join(process.cwd(), "rel"));
  });

  it("ignores an empty HYDRA_HOME", () => {
    expect(resolveHomePath(undefined, { HYDRA_HOME: "" })).toBe(join(homedir(), ".hydra"));
  });
});

describe("homePaths", () => {
  it("lays out the home", () => {
    const paths = homePaths("/srv/hydra", "/srv/hydra/data");
    expect(paths).toEqual({
      home: "/srv/hydra",
      configFile: "/srv/hydra/config.toml",
      credentialsFile: "/srv/hydra/credentials.json",
      dataDir: "/srv/hydra/data",
      databaseFile: "/srv/hydra/data/hydra.db",
      runnerDir: "/srv/hydra/runner",
      logsDir: "/srv/hydra/logs",
      backupsDir: "/srv/hydra/backups",
      tlsDir: "/srv/hydra/tls",
      setupUrlFile: "/srv/hydra/setup-url",
      masterKeyFile: "/srv/hydra/master.key",
    });
  });

  it("takes a Data Root outside the home, and resolves a relative one against it", () => {
    expect(homePaths("/srv/hydra", "/mnt/state").dataDir).toBe("/mnt/state");
    expect(homePaths("/srv/hydra", "state").databaseFile).toBe("/srv/hydra/state/hydra.db");
  });
});
