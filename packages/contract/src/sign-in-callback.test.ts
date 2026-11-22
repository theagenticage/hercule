import { describe, expect, it } from "vitest";
import { parseCallbackQuery, readAuthorizationState } from "./sign-in-callback";

/** Parses text that must be refused, and returns the reason. */
const refusal = (text: string): string => {
  const parsed = parseCallbackQuery(text);
  if (parsed._tag !== "Refused") throw new Error("the text was not refused");
  return parsed.reason;
};

describe("parseCallbackQuery", () => {
  it("reads a query, with or without the question mark, and an address", () => {
    const expected = { state: "s1", code: "c1", error: undefined, iss: "https://a.example" };
    const query = "code=c1&state=s1&iss=https%3A%2F%2Fa.example";

    expect(parseCallbackQuery(query)).toMatchObject({ ...expected, address: undefined });
    expect(parseCallbackQuery(`?${query}`)).toMatchObject({ ...expected, address: undefined });
    const parsed = parseCallbackQuery(`  http://127.0.0.1:50123/callback?${query}#fragment  `);
    expect(parsed).toMatchObject(expected);
    expect((parsed as { address?: URL }).address?.href).toBe(
      `http://127.0.0.1:50123/callback?${query}#fragment`,
    );
  });

  it("reads an error answer", () => {
    expect(parseCallbackQuery("error=access_denied&state=s1&error_description=no")).toMatchObject({
      state: "s1",
      code: undefined,
      error: "access_denied",
      iss: undefined,
    });
  });

  it("keeps an iss that is present and empty apart from one that is absent", () => {
    expect(parseCallbackQuery("code=c1&state=s1&iss=")).toMatchObject({ iss: "" });
    expect(parseCallbackQuery("code=c1&state=s1")).toMatchObject({ iss: undefined });
  });

  it("drops a fragment after a bare query", () => {
    expect(parseCallbackQuery("code=c1&state=s1#done")).toMatchObject({ code: "c1", state: "s1" });
  });

  it.each([
    ["a repeated parameter", "code=a&state=s&code=b", "a parameter appears twice"],
    ["a repeated state", "code=a&state=s&state=t", "a parameter appears twice"],
    ["a repeated parameter of another name", "code=a&state=s&x=1&x=2", "a parameter appears twice"],
    ["no state", "code=a", "there is no state"],
    ["an empty state", "code=a&state=", "there is no state"],
    ["no code and no error", "state=s", "both a code and an error, or neither"],
    ["both a code and an error", "code=a&error=access_denied&state=s", "both a code and an error"],
    ["an empty code", "code=&state=s", "both a code and an error, or neither"],
    ["an empty query", "", "there is no state"],
    ["text that only starts like an address", "http://[bad", "this is not an address"],
  ])("refuses %s", (_name, text, message) => {
    expect(refusal(text)).toContain(message);
  });

  it("never puts the text in the reason, because it holds a code", () => {
    expect(refusal("code=SECRET-CODE&state=s&state=t")).not.toContain("SECRET-CODE");
  });
});

describe("readAuthorizationState", () => {
  it("returns the state of an authorization address", () => {
    expect(readAuthorizationState("https://a.example/authorize?state=abc&x=1")).toBe("abc");
  });

  it("returns undefined when the state is missing or empty", () => {
    expect(readAuthorizationState("https://a.example/authorize?x=1")).toBeUndefined();
    expect(readAuthorizationState("https://a.example/authorize?state=")).toBeUndefined();
  });
});
