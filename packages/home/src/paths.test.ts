import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildHomePaths, resolveHomePath } from "./paths";

describe("resolveHomePath", () => {
  it("prefers --home, then HERCULE_HOME, then ~/.hercule", () => {
    expect(resolveHomePath("/tmp/flag", { HERCULE_HOME: "/tmp/env" })).toBe("/tmp/flag");
    expect(resolveHomePath(undefined, { HERCULE_HOME: "/tmp/env" })).toBe("/tmp/env");
    expect(resolveHomePath(undefined, {})).toBe(join(homedir(), ".hercule"));
  });

  it("makes a relative home absolute", () => {
    expect(resolveHomePath("rel", {})).toBe(join(process.cwd(), "rel"));
  });

  it("ignores an empty HERCULE_HOME", () => {
    expect(resolveHomePath(undefined, { HERCULE_HOME: "" })).toBe(join(homedir(), ".hercule"));
  });
});

describe("buildHomePaths", () => {
  it("lays out the home", () => {
    const paths = buildHomePaths("/srv/hercule", "/srv/hercule/data");
    expect(paths).toEqual({
      home: "/srv/hercule",
      configFile: "/srv/hercule/config.toml",
      credentialsFile: "/srv/hercule/credentials.json",
      dataDir: "/srv/hercule/data",
      databaseFile: "/srv/hercule/data/hercule.db",
      runnerDir: "/srv/hercule/runner",
      logsDir: "/srv/hercule/logs",
      backupsDir: "/srv/hercule/backups",
      tlsDir: "/srv/hercule/tls",
      setupUrlFile: "/srv/hercule/setup-url",
      masterKeyFile: "/srv/hercule/master.key",
    });
  });

  it("accepts a Data Root outside the home, and resolves a relative one against the home", () => {
    expect(buildHomePaths("/srv/hercule", "/mnt/state").dataDir).toBe("/mnt/state");
    expect(buildHomePaths("/srv/hercule", "state").databaseFile).toBe(
      "/srv/hercule/state/hercule.db",
    );
  });
});
