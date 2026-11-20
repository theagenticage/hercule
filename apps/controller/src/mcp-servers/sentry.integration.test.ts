/**
 * Tests the real Sentry plugin's MCP server through the catalogue, the way a
 * user reaches it with `hercule mcp-server create --plugin sentry/sentry`:
 * the operation creates the server, the check lists its tools from a fake
 * that stands in for `https://mcp.sentry.dev`, and the request that arrives
 * has Sentry's `Sentry-Bearer` header and its `disable-skills` query.
 *
 * Only the address is faked: the controller still believes it talks to
 * Sentry's origin, so the rule that a plugin's URL stays on its origin is
 * checked with the real declaration. The Sentry Connection is stored directly
 * because creating one asks the real Sentry who the token belongs to.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { sentry } from "@hercule/plugin-sentry";
import { withSetUpController } from "../workflows/testing";
import {
  createServer,
  insertPastedConnection,
  readServer,
  startFakeUpstream,
  waitForResult,
} from "./testing";

const SENTRY_MCP_ORIGIN = "https://mcp.sentry.dev";

describe("the Sentry MCP server", () => {
  it("is created from the catalogue and listed with Sentry's header and query", async () => {
    const fake = await startFakeUpstream({
      tools: [{ name: "search_issues", description: "Searches Sentry issues" }],
    });
    try {
      const fetchClient = await Effect.runPromise(
        Effect.provide(Effect.service(HttpClient.HttpClient), FetchHttpClient.layer),
      );
      // Sends what is meant for Sentry's origin to the fake, and refuses anything else.
      const routedToFake = HttpClient.makeWith<
        never,
        never,
        HttpClientError.HttpClientError,
        never
      >(
        (pending) =>
          Effect.flatMap(pending, (request) => {
            const url = new URL(request.url);
            return url.origin === SENTRY_MCP_ORIGIN
              ? fetchClient.execute(
                  HttpClientRequest.setUrl(request, `${fake.origin}${url.pathname}${url.search}`),
                )
              : Effect.die(new Error(`unexpected request to ${url.origin}`));
          }),
        Effect.succeed,
      );

      await withSetUpController(
        async (controller) => {
          const connectionId = await insertPastedConnection(
            controller.harness,
            "sentry/sentry",
            "sntrys_secret",
          );

          const created = await createServer(controller, {
            contributionId: "sentry/sentry",
            connectionId,
          });
          const row = await waitForResult(controller);

          expect(created).toMatchObject({ name: "sentry", status: "checking" });
          expect(row).toMatchObject({ status: "ready" });
          expect(await readServer(controller, created.id)).toMatchObject({
            status: "ready",
            tools: [{ name: "search_issues", description: "Searches Sentry issues" }],
          });
          expect(fake.requests.length).toBeGreaterThan(0);
          for (const request of fake.requests) {
            expect(request.authorization).toBe("Sentry-Bearer sntrys_secret");
            expect(request.url).toBe("/mcp?disable-skills=project-management");
          }
        },
        [sentry],
        { mcpUpstreamHttpClient: routedToFake },
      );
    } finally {
      await fake.stop();
    }
  });
});
