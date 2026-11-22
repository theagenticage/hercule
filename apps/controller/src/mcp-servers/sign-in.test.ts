/**
 * Tests how a sign-in reads what the browser came back with, without a
 * controller: the whole address or only the query, the refusals of text that
 * is not a redirect answer, and the comparison of a pasted address with the
 * redirect address of the attempt.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { isRedirectAddress, parseCallbackQuery } from "./sign-in";

const parse = (text: string) => Effect.runPromise(parseCallbackQuery(text));

/** Runs a parse that must fail with `Validation`, and returns the message of its one issue. */
const refusal = async (text: string): Promise<string> => {
  const error = await Effect.runPromise(Effect.flip(parseCallbackQuery(text)));
  expect(error.error.code).toBe("validation");
  return (error.error.details as { readonly issues: ReadonlyArray<{ readonly message: string }> })
    .issues[0]!.message;
};

describe("parseCallbackQuery", () => {
  it("reads a query, with or without the question mark, and an address", async () => {
    const expected = { state: "s1", code: "c1", error: undefined, iss: "https://a.example" };
    const query = "code=c1&state=s1&iss=https%3A%2F%2Fa.example";

    expect(await parse(query)).toMatchObject({ ...expected, address: undefined });
    expect(await parse(`?${query}`)).toMatchObject({ ...expected, address: undefined });
    const parsed = await parse(`  http://127.0.0.1:50123/callback?${query}#fragment  `);
    expect(parsed).toMatchObject(expected);
    expect(parsed.address?.href).toBe(`http://127.0.0.1:50123/callback?${query}#fragment`);
  });

  it("reads an error answer", async () => {
    expect(await parse("error=access_denied&state=s1&error_description=no")).toMatchObject({
      state: "s1",
      code: undefined,
      error: "access_denied",
      iss: undefined,
    });
  });

  it("drops a fragment after a bare query", async () => {
    expect(await parse("code=c1&state=s1#done")).toMatchObject({ code: "c1", state: "s1" });
  });

  it.each([
    ["a repeated parameter", "code=a&state=s&code=b", "a parameter appears twice"],
    ["a repeated parameter of another name", "code=a&state=s&x=1&x=2", "a parameter appears twice"],
    ["no state", "code=a", "there is no state"],
    ["an empty state", "code=a&state=", "there is no state"],
    ["no code and no error", "state=s", "both a code and an error, or neither"],
    ["both a code and an error", "code=a&error=access_denied&state=s", "both a code and an error"],
    ["an empty code", "code=&state=s", "both a code and an error, or neither"],
    ["text that only starts like an address", "http://[bad", "this is not an address"],
  ])("refuses %s", async (_name, text, message) => {
    expect(await refusal(text)).toContain(message);
  });

  it("never puts the text in the message, because it holds a code", async () => {
    expect(await refusal("code=SECRET-CODE&state=s&state=t")).not.toContain("SECRET-CODE");
  });
});

describe("isRedirectAddress", () => {
  const redirectUri = "http://127.0.0.1:50123/callback";

  it("accepts the redirect address with any query", () => {
    expect(isRedirectAddress(new URL(`${redirectUri}?code=a&state=b`), redirectUri)).toBe(true);
  });

  it("treats the default port as no port", () => {
    expect(
      isRedirectAddress(
        new URL("http://127.0.0.1/callback?code=a"),
        "http://127.0.0.1:80/callback",
      ),
    ).toBe(true);
  });

  it.each([
    ["another port", "http://127.0.0.1:50124/callback?code=a"],
    ["another host", "http://localhost:50123/callback?code=a"],
    ["another path", "http://127.0.0.1:50123/other?code=a"],
    ["another scheme", "https://127.0.0.1:50123/callback?code=a"],
    ["a user name", "http://user@127.0.0.1:50123/callback?code=a"],
  ])("refuses %s", (_name, address) => {
    expect(isRedirectAddress(new URL(address), redirectUri)).toBe(false);
  });
});
