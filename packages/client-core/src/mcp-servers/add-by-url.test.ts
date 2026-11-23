import { describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import {
  ADDRESS_FIELD_HINT,
  describeSignInHeading,
  describeTokenForm,
  describeToolNamePreview,
  readAddForm,
  readFieldIssues,
  readTokenField,
  suggestServerName,
} from "./add-by-url";
import { buildServer } from "./testing";

describe("suggestServerName", () => {
  it.each([
    ["https://mcp.notion.com/mcp", "notion"],
    ["https://www.example.com", "example"],
    ["https://api.mcp.linear.app/sse", "linear"],
    ["https://MCP.Sentry.dev./mcp", "sentry"],
    ["  https://mcp.notion.com/mcp  ", "notion"],
    ["http://localhost:8080/mcp", "localhost"],
    ["http://192.168.0.1/mcp", "192"],
    ["https://my-docs.example.com", "my_docs"],
    ["https://a-very-long-company-name.example.com", "a_very_long_comp"],
    ["https://abcdefghijklmno-pq.example.com", "abcdefghijklmno"],
  ])("suggests for %s the name %s", (address, name) => {
    expect(suggestServerName(address)).toBe(name);
  });

  it.each([
    ["nothing typed", ""],
    ["text that is not an address", "notion"],
    ["an address that is not http or https", "ftp://mcp.notion.com"],
    ["a host of generic labels only", "https://mcp.www.api/x"],
    ["the reserved name", "https://hercule.example.com"],
  ])("suggests no name for %s", (_what, address) => {
    expect(suggestServerName(address)).toBeNull();
  });
});

describe("describeToolNamePreview", () => {
  it("shows the typed name in the tool name's code span", () => {
    expect(describeToolNamePreview("notion")).toEqual([
      { text: "Agents see its tools as ", code: false },
      { text: "mcp__tools__notion__<tool>", code: true },
    ]);
  });

  it("shows <name> while the field is empty", () => {
    expect(describeToolNamePreview("")[1]).toEqual({
      text: "mcp__tools__<name>__<tool>",
      code: true,
    });
  });
});

describe("readAddForm", () => {
  const ADDRESS = "https://mcp.notion.com/mcp";

  it("follows the suggestion while the name is untouched, and leaves the name out of the create", () => {
    expect(readAddForm({ address: ADDRESS, typedName: null })).toMatchObject({
      name: "notion",
      nameIssue: null,
      createName: undefined,
      createAddress: ADDRESS,
      canSubmit: true,
    });
    expect(readAddForm({ address: "https://mcp.linear.app/sse", typedName: null }).name).toBe(
      "linear",
    );
  });

  it("keeps a typed name when the address changes, and sends it", () => {
    const form = readAddForm({ address: "https://mcp.linear.app/sse", typedName: "wiki" });

    expect(form).toMatchObject({ name: "wiki", createName: "wiki", canSubmit: true });
    expect(form.preview[1]?.text).toBe("mcp__tools__wiki__<tool>");
  });

  it("counts a blank typed name as untouched", () => {
    expect(readAddForm({ address: ADDRESS, typedName: "  " })).toMatchObject({
      name: "notion",
      createName: undefined,
    });
  });

  it.each(["Wiki", "my-wiki", "hercule", "a__b", "a-very-long-company-name"])(
    "refuses the typed name %s by the contract's name rule",
    (typedName) => {
      const form = readAddForm({ address: ADDRESS, typedName });

      expect(form.nameIssue).toContain("lowercase letters, digits and single _");
      expect(form.canSubmit).toBe(false);
    },
  );

  it("cannot send without an address, and never refuses an address by its scheme", () => {
    expect(readAddForm({ address: "  ", typedName: null }).canSubmit).toBe(false);
    expect(readAddForm({ address: "http://localhost:8080/mcp", typedName: null })).toMatchObject({
      canSubmit: true,
      name: "localhost",
    });
    // The controller decides: it says what is wrong with text that is no address.
    expect(readAddForm({ address: "notion", typedName: null })).toMatchObject({
      canSubmit: true,
      name: "",
      createName: undefined,
    });
  });

  it("sends the address trimmed", () => {
    expect(readAddForm({ address: `  ${ADDRESS}\n`, typedName: null }).createAddress).toBe(ADDRESS);
  });
});

describe("readTokenField", () => {
  it("cannot send an empty field, and shows no issue for it yet", () => {
    expect(readTokenField("")).toEqual({ issue: null, canSubmit: false });
  });

  it("accepts a bearer token", () => {
    expect(readTokenField("sk_live-1234.abcd~+/=")).toEqual({ issue: null, canSubmit: true });
  });

  it.each(["short", "Bearer abcdefghijk", "has space inside"])(
    "refuses %s with the contract's sentence",
    (token) => {
      const { issue, canSubmit } = readTokenField(token);

      expect(canSubmit).toBe(false);
      expect(issue).toContain("A token is at least 8 printable characters");
    },
  );
});

describe("readFieldIssues", () => {
  const validation = (issues: { path: string[]; message: string }[]) =>
    new ApiError("validation", "Invalid.", { issues });

  it("puts each issue at the field its path names, and the rest in other", () => {
    expect(
      readFieldIssues(
        validation([
          { path: ["source", "url"], message: "Not an address." },
          { path: ["source", "name"], message: "No usable name." },
          { path: ["token"], message: "Bad token." },
          { path: ["source"], message: "Something else." },
        ]),
      ),
    ).toEqual({
      address: "Not an address.",
      name: "No usable name.",
      token: "Bad token.",
      other: "Something else.",
    });
  });

  it("is undefined for an error that is not a validation error", () => {
    expect(readFieldIssues(new ApiError("conflict", "Taken."))).toBeUndefined();
    expect(readFieldIssues(new Error("offline"))).toBeUndefined();
  });
});

describe("describeTokenForm", () => {
  const urlServer = (
    signIn: "none" | "token" | "oauth",
    signInOffered: "token" | "oauth" | null,
    overrides = {},
  ) =>
    buildServer("s-docs", "docs", "", {
      source: { kind: "url", url: "https://docs.example.com/mcp", signIn, signInOffered },
      ...overrides,
    });

  it("asks a new server for a token", () => {
    expect(describeTokenForm(urlServer("none", "token", { status: "needs-sign-in" }))).toEqual({
      intro: "This server needs a token.",
      method: "token",
      problemText: undefined,
      browser: null,
      note: "Kept on the controller. It never reaches a runner.",
      offNote: null,
      submitLabel: "Save token",
    });
  });

  it("says the token was refused when the server holds one and refuses it", () => {
    expect(describeTokenForm(urlServer("token", "token", { status: "needs-sign-in" })).intro).toBe(
      "The server refused its token. Paste a new one.",
    );
  });

  it("offers the browser first for a server that asks for OAuth, with the pasted token as the other way, never called signing in", () => {
    const { intro, browser } = describeTokenForm(
      urlServer("none", "oauth", { status: "needs-sign-in" }),
    );

    expect(browser).toEqual({
      intro: "This server signs in through your browser.",
      label: "Sign in with your browser",
      pasteToggle: "Paste a token instead",
    });
    expect(intro).toBe("Paste a token, if the service gives you one.");
    expect(intro).not.toMatch(/sign(ing)? in/i);
  });

  it("offers the browser for a server that holds an OAuth sign-in, and none for the others", () => {
    expect(describeTokenForm(urlServer("oauth", "oauth")).browser).not.toBeNull();
    expect(describeTokenForm(urlServer("token", "token")).browser).toBeNull();
    expect(describeTokenForm(urlServer("none", null)).browser).toBeNull();
  });

  it("opens with the token field when the server holds a pasted token, though it still offers the browser: a refused token and Replace token…", () => {
    const refused = describeTokenForm(urlServer("token", "oauth", { status: "needs-sign-in" }));
    const replacing = describeTokenForm(urlServer("token", "oauth"));

    expect(refused).toMatchObject({
      method: "token",
      intro: "The server refused its token. Paste a new one.",
    });
    expect(replacing).toMatchObject({
      method: "token",
      intro: "Paste a new token. It replaces the one this server holds.",
    });
    // The browser stays the quiet other way.
    expect(refused.browser).not.toBeNull();
    expect(replacing.browser).not.toBeNull();
  });

  it("opens with the browser choice for a refused browser sign-in, for a server that holds none, and again after Sign in again…", () => {
    expect(describeTokenForm(urlServer("oauth", "oauth", { status: "needs-sign-in" })).method).toBe(
      "browser",
    );
    expect(describeTokenForm(urlServer("none", "oauth", { status: "needs-sign-in" })).method).toBe(
      "browser",
    );
    expect(describeTokenForm(urlServer("oauth", "oauth")).method).toBe("browser");
  });

  it("drops the browser choice and shows the controller's words once only a token works, whatever was offered", () => {
    const server = urlServer("none", "oauth", { status: "needs-sign-in" });
    const words = describeTokenForm(server, {
      kind: "sign-in-unsupported",
      message: "No browser here. Paste a token instead.",
    });

    expect(words.browser).toBeNull();
    expect(words.method).toBe("token");
    expect(words.problemText).toBe("No browser here. Paste a token instead.");
    expect(words.intro).toBe("This server needs a token.");
  });

  it("shows the reason of the last token write beside the field, and puts the field first", () => {
    const server = urlServer("none", "oauth", { status: "needs-sign-in" });
    const invalid = describeTokenForm(server, {
      kind: "invalid",
      issues: { address: null, name: null, token: "Too short.", other: "Also this." },
    });
    const failed = describeTokenForm(server, { kind: "failed", message: "offline" });

    expect(invalid).toMatchObject({ method: "token", problemText: "Too short. Also this." });
    expect(failed).toMatchObject({ method: "token", problemText: "offline" });
    expect(describeTokenForm(server, null).method).toBe("browser");
  });

  it("tells the address form that a key goes in the token field, not the address", () => {
    expect(ADDRESS_FIELD_HINT).toContain("token field");
    expect(ADDRESS_FIELD_HINT).toContain("leave it out of the address");
  });

  it("titles the dialog by what the user does there", () => {
    expect(describeSignInHeading(urlServer("none", "token", { status: "needs-sign-in" }))).toBe(
      "Sign in to docs",
    );
    expect(describeSignInHeading(urlServer("oauth", "oauth"))).toBe("Sign in to docs");
    expect(describeSignInHeading(urlServer("token", "token"))).toBe("Replace the token of docs");
  });

  it("says a new token replaces the old one when the server works", () => {
    expect(describeTokenForm(urlServer("token", "token")).intro).toBe(
      "Paste a new token. It replaces the one this server holds.",
    );
  });

  it("says checking waits while the server is switched off", () => {
    expect(describeTokenForm(urlServer("token", "token", { enabled: false })).offNote).toBe(
      "This server is switched off. The token is saved, and checking runs when it is switched on.",
    );
  });
});
