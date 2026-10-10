import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { buildHomePaths, isInSession, resolveHomePath, resolveHomePathToActOn } from "./paths";

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

  it("takes an empty --home as the default Home, without falling back to HERCULE_HOME", () => {
    expect(resolveHomePath("", { HERCULE_HOME: "/tmp/env" })).toBe(join(homedir(), ".hercule"));
  });
});

describe("resolveHomePathToActOn", () => {
  const SESSION = { HERCULE_SESSION: "1" };

  it("refuses the default Home inside a session, and names it in the message", () => {
    const resolved = resolveHomePathToActOn(undefined, SESSION);

    expect(Result.isFailure(resolved) && resolved.failure.option).toBe("--home");
    // The message names the path the command would have used, so the agent
    // sees that it is the user's live Home.
    expect(Result.isFailure(resolved) && resolved.failure.message).toContain(
      join(homedir(), ".hercule"),
    );
  });

  it("refuses an empty HERCULE_HOME inside a session, because it names no Home", () => {
    const resolved = resolveHomePathToActOn(undefined, { ...SESSION, HERCULE_HOME: "" });

    expect(Result.isFailure(resolved) && resolved.failure.option).toBe("--home");
  });

  it("accepts a Home named by --home or by HERCULE_HOME inside a session", () => {
    expect(resolveHomePathToActOn("/tmp/flag", SESSION)).toEqual(Result.succeed("/tmp/flag"));
    expect(resolveHomePathToActOn(undefined, { ...SESSION, HERCULE_HOME: "/tmp/env" })).toEqual(
      Result.succeed("/tmp/env"),
    );
  });

  it("returns the default Home outside a session", () => {
    expect(resolveHomePathToActOn(undefined, {})).toEqual(
      Result.succeed(join(homedir(), ".hercule")),
    );
  });
});

describe("isInSession", () => {
  it("is true only when HERCULE_SESSION is exactly 1", () => {
    expect(isInSession({ HERCULE_SESSION: "1" })).toBe(true);
    expect(isInSession({ HERCULE_SESSION: "0" })).toBe(false);
    expect(isInSession({ HERCULE_SESSION: "" })).toBe(false);
    expect(isInSession({ HERCULE_SESSION: "true" })).toBe(false);
    expect(isInSession({})).toBe(false);
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
      promotionTransferDir: "/srv/hercule/data/promotion-transfer",
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
    expect(buildHomePaths("/srv/hercule", "/mnt/state").promotionTransferDir).toBe(
      "/mnt/state/promotion-transfer",
    );
    expect(buildHomePaths("/srv/hercule", "state").databaseFile).toBe(
      "/srv/hercule/state/hercule.db",
    );
  });
});
