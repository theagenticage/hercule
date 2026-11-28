import { describe, expect, it } from "vitest";
import { readPiProvider } from "./provider";

describe("the pi provider of a model argument", () => {
  it("is the part before the model placeholder", () => {
    expect(readPiProvider("zai/{model}")).toBe("zai");
    expect(readPiProvider("openrouter/{model}")).toBe("openrouter");
    expect(readPiProvider("amazon-bedrock/{model}")).toBe("amazon-bedrock");
  });

  it("refuses an argument without a provider, and says which argument it was", () => {
    for (const modelArgument of ["{model}", "/{model}", "zai/model", "zai", "", "a/b/{model}"]) {
      expect(() => readPiProvider(modelArgument), modelArgument).toThrow(
        `but this account's is "${modelArgument}"`,
      );
    }
  });

  it("refuses a placeholder in the provider part", () => {
    expect(() => readPiProvider("{model}/{model}")).toThrow("<provider>/{model}");
  });
});
