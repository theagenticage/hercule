/**
 * Tests the Ignore Rule operations over a real socket, with the shipped
 * github plugin loaded so `github/review-requested` is a declared kind:
 *
 * - a rule is created, listed with nothing caught yet, and deleted, after
 *   which a second delete is not found;
 * - the contract refuses a rule with no values before the service sees it.
 *
 * Who may call each operation, and which signals a new rule resolves, are
 * tested in `ignore-rules.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { IgnoreRule, IgnoreRuleWithCatches } from "@hercule/contract";
import { github } from "@hercule/plugin-github";
import { completeSetup, del, get, post, readErrorBody, withServer } from "../http/testing";

const KIND = "github/review-requested";

/** Runs `body` against a controller with the github plugin, using the user's credential. */
const withIgnoreRules = (body: (base: string, token: string) => Promise<void>): Promise<void> =>
  withServer(
    async ({ base }) => {
      const token = await completeSetup(base);
      await body(base, token);
    },
    { plugins: [github] },
  );

/** Lists the rules, of one kind when `kind` is given. Fails the test unless the call succeeds. */
const listRules = async (
  base: string,
  token: string,
  kind?: string,
): Promise<ReadonlyArray<IgnoreRuleWithCatches>> => {
  const query = kind === undefined ? "" : `?kind=${encodeURIComponent(kind)}`;
  const response = await get(base, `/api/v1/ignore-rules${query}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ReadonlyArray<IgnoreRuleWithCatches>;
};

describe("Ignore Rules over HTTP", () => {
  it("creates a rule, lists it with nothing caught, and deletes it once", async () => {
    await withIgnoreRules(async (base, token) => {
      const created = await post(
        base,
        "/api/v1/ignore-rules",
        { kind: KIND, match: { author: "dependabot[bot]", repo: "acme/webshop" } },
        token,
      );
      expect(created.status, await created.clone().text()).toBe(200);
      const rule = (await created.json()) as IgnoreRule;
      expect(rule).toMatchObject({
        kind: KIND,
        match: { repo: "acme/webshop", author: "dependabot[bot]" },
        text: "Review requested · Repository acme/webshop · Author dependabot[bot]",
        actor: "user",
      });

      expect(await listRules(base, token)).toEqual([{ ...rule, caughtCount: 0 }]);
      expect(await listRules(base, token, KIND)).toHaveLength(1);
      expect(await listRules(base, token, "github/mentioned")).toEqual([]);

      const deleted = await del(base, `/api/v1/ignore-rules/${rule.id}`, token);
      expect(deleted.status, await deleted.clone().text()).toBe(200);
      expect(await deleted.json()).toEqual({});
      expect(await listRules(base, token)).toEqual([]);

      const again = await del(base, `/api/v1/ignore-rules/${rule.id}`, token);
      expect(again.status).toBe(404);
      expect((await readErrorBody(again)).code).toBe("not_found");
    });
  });

  it("refuses a rule with no values", async () => {
    await withIgnoreRules(async (base, token) => {
      const response = await post(base, "/api/v1/ignore-rules", { kind: KIND, match: {} }, token);

      expect(response.status).toBe(400);
      const refusal = await readErrorBody(response);
      expect(refusal.code).toBe("validation");
      expect(refusal.text).toContain("A rule needs at least one value to match on");
      expect(await listRules(base, token)).toEqual([]);
    });
  });
});
