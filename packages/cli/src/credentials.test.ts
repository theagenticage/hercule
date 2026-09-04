import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialError, resolveCredential, resolveUrl } from "./credentials";

let home: string;

const writeCredentials = (contents: unknown): void => {
  writeFileSync(
    join(home, "credentials.json"),
    typeof contents === "string" ? contents : JSON.stringify(contents),
    { mode: 0o600 },
  );
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hydra-credentials-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("resolveCredential", () => {
  it("takes the environment token first", () => {
    writeCredentials({ url: "http://file", apiKey: "from-file" });
    expect(
      resolveCredential(home, { HYDRA_TOKEN: "from-env", HYDRA_API_URL: "http://env" }),
    ).toEqual({ url: "http://env", token: "from-env", source: "environment" });
  });

  it("takes the file when the environment has no token", () => {
    writeCredentials({ url: "http://file", apiKey: "from-file" });
    expect(resolveCredential(home, {})).toEqual({
      url: "http://file",
      token: "from-file",
      source: "file",
    });
  });

  it("lets HYDRA_API_URL point the file's key at another controller", () => {
    writeCredentials({ url: "http://file", apiKey: "from-file" });
    expect(resolveCredential(home, { HYDRA_API_URL: "http://env" }).url).toBe("http://env");
  });

  it("refuses the file outright inside a session", () => {
    writeCredentials({ url: "http://file", apiKey: "from-file" });
    expect(() => resolveCredential(home, { HYDRA_SESSION: "1" })).toThrow(CredentialError);
    expect(() => resolveCredential(home, { HYDRA_SESSION: "1" })).toThrow(/HYDRA_SESSION=1/);
  });

  it("still takes the environment token inside a session", () => {
    writeCredentials({ url: "http://file", apiKey: "from-file" });
    expect(
      resolveCredential(home, {
        HYDRA_SESSION: "1",
        HYDRA_TOKEN: "session-token",
        HYDRA_API_URL: "http://controller",
      }),
    ).toEqual({ url: "http://controller", token: "session-token", source: "environment" });
  });

  it("says what to do when there is nothing at all", () => {
    expect(() => resolveCredential(home, {})).toThrow(/hydra login/);
  });

  it("refuses a token with no URL", () => {
    expect(() => resolveCredential(home, { HYDRA_TOKEN: "t" })).toThrow(/HYDRA_API_URL/);
  });

  it("treats a broken credential file as an error, not as anonymity", () => {
    writeCredentials("not json");
    expect(() => resolveCredential(home, {})).toThrow(/not valid JSON/);
    writeCredentials({ url: "http://file" });
    expect(() => resolveCredential(home, {})).toThrow(/apiKey/);
  });
});

describe("resolveUrl", () => {
  it("prefers the environment, then the file", () => {
    writeCredentials({ url: "http://file", apiKey: "k" });
    expect(resolveUrl(home, { HYDRA_API_URL: "http://env" })).toBe("http://env");
    expect(resolveUrl(home, {})).toBe("http://file");
  });

  it("fails inside a session with no HYDRA_API_URL", () => {
    writeCredentials({ url: "http://file", apiKey: "k" });
    expect(() => resolveUrl(home, { HYDRA_SESSION: "1" })).toThrow(/HYDRA_API_URL/);
  });
});
