import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { HarnessAccount, HarnessHome, ProviderAccountId } from "./primitives";

const isAccepted = (schema: Schema.Decoder<unknown>, input: unknown) =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(schema)(input))._tag === "Success";

const omitField = (value: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

const ACCOUNT_ID = "0199c3f4-1f2a-7c31-9f0e-6d2b8a4e5c73";

describe("a Provider Account id", () => {
  it("accepts a uuid and the other identifier characters", () => {
    expect(isAccepted(ProviderAccountId, ACCOUNT_ID)).toBe(true);
    expect(isAccepted(ProviderAccountId, "acct_1-b")).toBe(true);
  });

  it("refuses anything that is not one path-safe word", () => {
    for (const id of ["", "..", "../x", "a/b", "a b", "a.b", "a".repeat(65)]) {
      expect(isAccepted(ProviderAccountId, id), id).toBe(false);
    }
  });
});

describe("a Harness Home", () => {
  it("accepts the legacy folder of an account", () => {
    expect(isAccepted(HarnessHome, `providers/${ACCOUNT_ID}`)).toBe(true);
  });

  it("accepts a derived home of an account and a qualified harness id", () => {
    expect(isAccepted(HarnessHome, `providers/homes/${ACCOUNT_ID}/claude-code/claude-code`)).toBe(
      true,
    );
    expect(isAccepted(HarnessHome, `providers/homes/${ACCOUNT_ID}/my.plugin_1/h-2`)).toBe(true);
  });

  it("refuses a segment longer than an id may be", () => {
    const long = "a".repeat(65);
    const fits = "a".repeat(64);
    expect(isAccepted(HarnessHome, `providers/${long}`)).toBe(false);
    expect(isAccepted(HarnessHome, `providers/${fits}`)).toBe(true);
    expect(isAccepted(HarnessHome, `providers/homes/${long}/pi/pi`)).toBe(false);
    expect(isAccepted(HarnessHome, `providers/homes/${ACCOUNT_ID}/${long}/pi`)).toBe(false);
    expect(isAccepted(HarnessHome, `providers/homes/${ACCOUNT_ID}/pi/${long}`)).toBe(false);
    expect(isAccepted(HarnessHome, `providers/homes/${fits}/${fits}/${fits}`)).toBe(true);
  });

  it("refuses a path that climbs out of the storage directory", () => {
    for (const home of [
      "providers/..",
      "providers/../x",
      "providers/../../etc",
      `providers/${ACCOUNT_ID}/..`,
      `providers/homes/${ACCOUNT_ID}/../pi`,
      `providers/homes/${ACCOUNT_ID}/pi/..`,
      `providers/homes/${ACCOUNT_ID}/./pi`,
      `providers/homes/../claude-code/claude-code`,
      `providers/homes/${ACCOUNT_ID}/.hidden/pi`,
      `providers/homes/${ACCOUNT_ID}/pi/.hidden`,
    ]) {
      expect(isAccepted(HarnessHome, home), home).toBe(false);
    }
  });

  it("refuses an absolute path and a path with a backslash", () => {
    for (const home of [
      `/providers/${ACCOUNT_ID}`,
      `/etc/passwd`,
      `C:/providers/${ACCOUNT_ID}`,
      `providers\\${ACCOUNT_ID}`,
      `providers/homes\\${ACCOUNT_ID}/pi/pi`,
    ]) {
      expect(isAccepted(HarnessHome, home), home).toBe(false);
    }
  });

  it("refuses every other shape: extra or missing segments, empty words, wrong roots", () => {
    for (const home of [
      "",
      "providers",
      "providers/",
      `providers/${ACCOUNT_ID}/`,
      `providers/${ACCOUNT_ID}/pi`,
      `providers/${ACCOUNT_ID}/pi/pi`,
      `providers/homes`,
      `providers/homes/${ACCOUNT_ID}`,
      `providers/homes/${ACCOUNT_ID}/pi`,
      `providers/homes/${ACCOUNT_ID}/pi/`,
      `providers/homes/${ACCOUNT_ID}//pi`,
      `providers/homes//pi/pi`,
      `providers/homes/${ACCOUNT_ID}/pi/pi/extra`,
      `providers/homes/${ACCOUNT_ID}/pi/pi/`,
      `provider/${ACCOUNT_ID}`,
      `Providers/${ACCOUNT_ID}`,
      `./providers/${ACCOUNT_ID}`,
      `x/providers/${ACCOUNT_ID}`,
      `providers/${ACCOUNT_ID}\n`,
      `providers/${ACCOUNT_ID} `,
      `providers/${"a".repeat(300)}`,
    ]) {
      expect(isAccepted(HarnessHome, home), JSON.stringify(home)).toBe(false);
    }
  });
});

describe("a Harness Account", () => {
  const account = {
    providerAccountId: ACCOUNT_ID,
    harnessHome: `providers/homes/${ACCOUNT_ID}/pi/pi`,
    modelArgument: "zai/{model}",
  };

  it("accepts an account without a credential, and one with it", () => {
    expect(isAccepted(HarnessAccount, account)).toBe(true);
    expect(
      isAccepted(HarnessAccount, {
        ...account,
        credential: { variable: "ZAI_API_KEY", value: "sk-test" },
      }),
    ).toBe(true);
  });

  it("needs the id, the home and the model argument", () => {
    expect(isAccepted(HarnessAccount, omitField(account, "providerAccountId"))).toBe(false);
    expect(isAccepted(HarnessAccount, omitField(account, "harnessHome"))).toBe(false);
    expect(isAccepted(HarnessAccount, omitField(account, "modelArgument"))).toBe(false);
  });

  it("refuses a model argument that does not have exactly one model placeholder", () => {
    for (const modelArgument of [
      "zai/model",
      "",
      "{model}{model}",
      "{model}/{model}",
      "a/{model}}",
    ]) {
      expect(isAccepted(HarnessAccount, { ...account, modelArgument }), modelArgument).toBe(false);
    }
    expect(isAccepted(HarnessAccount, { ...account, modelArgument: "{model}" })).toBe(true);
  });

  it("refuses a credential variable that is not an upper-case environment variable name", () => {
    const withVariable = (variable: string) => ({
      ...account,
      credential: { variable, value: "sk-test" },
    });
    for (const variable of ["", "zai_api_key", "1KEY", "A-B", "A B", "A=B", "PATH\n"]) {
      expect(isAccepted(HarnessAccount, withVariable(variable)), variable).toBe(false);
    }
    expect(isAccepted(HarnessAccount, withVariable("ANTHROPIC_API_KEY"))).toBe(true);
  });

  it("accepts a credential variable without a value, for an account with no key stored", () => {
    expect(
      isAccepted(HarnessAccount, { ...account, credential: { variable: "ZAI_API_KEY" } }),
    ).toBe(true);
  });

  it("refuses an empty credential value", () => {
    expect(
      isAccepted(HarnessAccount, { ...account, credential: { variable: "KEY", value: "" } }),
    ).toBe(false);
  });
});
