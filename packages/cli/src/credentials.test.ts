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
  home = mkdtempSync(join(tmpdir(), "hercule-credentials-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("resolveCredential", () => {
  it("uses the environment token first", () => {
    writeCredentials({ url: "http://file", apiKey: "from-file" });
    expect(
      resolveCredential(home, { HERCULE_TOKEN: "from-env", HERCULE_API_URL: "http://env" }),
    ).toEqual({ url: "http://env", token: "from-env", source: "environment" });
  });

  it("uses the file when the environment has no token", () => {
    writeCredentials({ url: "http://file", apiKey: "from-file" });
    expect(resolveCredential(home, {})).toEqual({
      url: "http://file",
      token: "from-file",
      source: "file",
    });
  });

  it("never sends the file's key to a URL from the environment", () => {
    writeCredentials({ url: "http://file", apiKey: "from-file" });
    expect(() => resolveCredential(home, { HERCULE_API_URL: "http://env" })).toThrow(
      CredentialError,
    );
    expect(() => resolveCredential(home, { HERCULE_API_URL: "http://env" })).toThrow(
      /HERCULE_API_URL is set but HERCULE_TOKEN is not/,
    );
  });

  it("rejects a lone HERCULE_API_URL even when there is no credential file", () => {
    expect(() => resolveCredential(home, { HERCULE_API_URL: "http://env" })).toThrow(
      /HERCULE_TOKEN/,
    );
  });

  it("ignores an empty HERCULE_API_URL, which is not a URL", () => {
    writeCredentials({ url: "http://file", apiKey: "from-file" });
    expect(resolveCredential(home, { HERCULE_API_URL: "" })).toEqual({
      url: "http://file",
      token: "from-file",
      source: "file",
    });
  });

  it("never reads the file inside a session", () => {
    writeCredentials({ url: "http://file", apiKey: "from-file" });
    expect(() => resolveCredential(home, { HERCULE_SESSION: "1" })).toThrow(CredentialError);
    expect(() => resolveCredential(home, { HERCULE_SESSION: "1" })).toThrow(/HERCULE_SESSION=1/);
  });

  it("still uses the environment token inside a session", () => {
    writeCredentials({ url: "http://file", apiKey: "from-file" });
    expect(
      resolveCredential(home, {
        HERCULE_SESSION: "1",
        HERCULE_TOKEN: "session-token",
        HERCULE_API_URL: "http://controller",
      }),
    ).toEqual({ url: "http://controller", token: "session-token", source: "environment" });
  });

  it("says what to do when there is no credential at all", () => {
    expect(() => resolveCredential(home, {})).toThrow(/hercule login/);
  });

  it("rejects a token with no URL", () => {
    expect(() => resolveCredential(home, { HERCULE_TOKEN: "t" })).toThrow(/HERCULE_API_URL/);
  });

  it("treats a broken credential file as an error, not as no credential", () => {
    writeCredentials("not json");
    expect(() => resolveCredential(home, {})).toThrow(/not valid JSON/);
    writeCredentials({ url: "http://file" });
    expect(() => resolveCredential(home, {})).toThrow(/apiKey/);
  });
});

describe("resolveUrl", () => {
  it("prefers the environment, then the file", () => {
    writeCredentials({ url: "http://file", apiKey: "k" });
    expect(resolveUrl(home, { HERCULE_API_URL: "http://env" })).toBe("http://env");
    expect(resolveUrl(home, {})).toBe("http://file");
  });

  it("uses a lone HERCULE_API_URL, which has no credential to leak", () => {
    expect(resolveUrl(home, { HERCULE_API_URL: "http://env" })).toBe("http://env");
  });

  it("fails inside a session with no HERCULE_API_URL", () => {
    writeCredentials({ url: "http://file", apiKey: "k" });
    expect(() => resolveUrl(home, { HERCULE_SESSION: "1" })).toThrow(/HERCULE_API_URL/);
  });
});
