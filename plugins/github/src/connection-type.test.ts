/** Tests the GitHub Connection's config: what it accepts, and that the settings form can render it. */
import { describe, expect, it } from "vitest";
import { Result, Schema } from "effect";
import { deriveConfigJsonSchema } from "@hercule/plugin-host";
import { GithubConnectionConfig } from "./connection-type";

const decodeConfig = Schema.decodeUnknownResult(GithubConnectionConfig);

describe("the GitHub Connection's config", () => {
  it("renders as a form of a list of repositories and a whole number", () => {
    const result = deriveConfigJsonSchema(GithubConnectionConfig);

    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    const properties = result.success.properties as Record<string, Record<string, unknown>>;
    expect(properties["repos"]).toMatchObject({ type: "array", items: { type: "string" } });
    expect(properties["checksWindowDays"]).toMatchObject({ type: "integer", default: 7 });
    expect(result.success.required ?? []).toEqual([]);
  });

  it("accepts the empty config every existing Connection has, and leaves the window unset", () => {
    expect(decodeConfig({})).toEqual(Result.succeed({}));
  });

  it("accepts repositories as owner/repo and a window from 1 to 30 days", () => {
    const result = decodeConfig({
      repos: ["octocat/hello-world", "a-b/c.d_e"],
      checksWindowDays: 30,
    });

    expect(Result.isSuccess(result)).toBe(true);
  });

  it("refuses a repository that is not owner/repo, and a window outside 1 to 30", () => {
    expect(Result.isFailure(decodeConfig({ repos: ["hello-world"] }))).toBe(true);
    expect(Result.isFailure(decodeConfig({ repos: ["github.com/octocat/hello-world"] }))).toBe(
      true,
    );
    expect(Result.isFailure(decodeConfig({ checksWindowDays: 0 }))).toBe(true);
    expect(Result.isFailure(decodeConfig({ checksWindowDays: 31 }))).toBe(true);
    expect(Result.isFailure(decodeConfig({ checksWindowDays: 1.5 }))).toBe(true);
  });
});
