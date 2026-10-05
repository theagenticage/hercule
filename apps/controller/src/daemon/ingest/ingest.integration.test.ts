/**
 * Tests ingest end to end on a running controller: the user connects an
 * account of a plugin's Connection type, the Ingest Reconciler opens the
 * plugin's event source for it, the source's second poll emits an event, and
 * the event pipeline starts a workflow's run from that event.
 *
 * The plugin is a local one. Its feed records where it stands on its first
 * poll and emits one event on each later poll, as a real source does so a
 * new Connection never emits history. Its credentials check accepts one
 * token, so nothing reaches the network.
 */
import { describe, expect, it, vi } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AuthError,
  HOST_API,
  PluginError,
  registerConnectionType,
  registerEventSource,
  type Plugin,
} from "@hercule/plugin-host";
import { readEvent } from "../../events/testing";
import { readConnection } from "../../connections/testing";
import { queryRuns, waitForRunToFinish } from "../../runs/testing";
import { waitUntil, WAIT_DEADLINE_MS } from "../../sessions/testing";
import {
  createConnection,
  createWorkflowOrFail,
  enableWorkflow,
  withSetUpController,
  type SetUpController,
} from "../../workflows/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

/** The token whose polls succeed. Any other token is rejected by the feed. */
const ACCEPTED_TOKEN = "acme-token";

/**
 * A plugin with the Connection type `acme/acme` and an event source for it.
 * The source's one feed, polled every second, stores a baseline on its first
 * poll and emits `acme.thing.done` on every later one, with the same dedup
 * key each time, so the event log holds it once. A Connection whose token is
 * not `ACCEPTED_TOKEN` has its poll fail with an `AuthError`, before any
 * baseline.
 */
const acmePlugin: Plugin = {
  manifest: {
    id: "acme",
    displayName: "Acme",
    hostApi: HOST_API,
    capabilities: ["connections", "event-sources", "events"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    Effect.andThen(
      registerConnectionType(host, {
        type: "acme",
        displayName: "Acme",
        setup: [{ kind: "credentials", fields: [{ name: "token", label: "API token" }] }],
        validate: () => Effect.succeed({ displayName: "Acme", accountId: "acme-1" }),
      }),
      registerEventSource(host, {
        id: "acme",
        connectionType: "acme/acme",
        feeds: { things: { defaultIntervalSeconds: 1 } },
        kinds: {
          "acme.thing.done": {
            description: "Something was done in Acme.",
            schema: Schema.Struct({ title: Schema.String }),
          },
        },
        open: (_, context) =>
          Effect.succeed({
            poll: () =>
              Effect.gen(function* () {
                const credentials = yield* Effect.mapError(
                  context.credentials(),
                  (error) => new PluginError({ message: error.message }),
                );
                if (credentials["token"] !== ACCEPTED_TOKEN) {
                  return yield* Effect.fail(new AuthError({ message: "Acme rejected the token." }));
                }
                if (Option.isNone(yield* context.state.get("baseline"))) {
                  yield* context.state.set("baseline", true);
                  return {};
                }
                yield* context.emit({
                  kind: "acme.thing.done",
                  dedupKey: "thing-1",
                  occurredAt: "2026-09-01T10:00:00Z",
                  payload: { title: "Shipped" },
                  refs: [],
                  url: "https://acme.example/things/1",
                });
                return {};
              }),
            close: Effect.void,
          }),
      }),
    ),
  activate: () => Effect.succeed(Effect.void),
};

/** A workflow whose start trigger files a task for every `acme.thing.done`. */
const THING_DONE_SOURCE = `name: File done things
inputs:
  - name: title
    schema:
      type: string
    required: true
triggers:
  - id: done
    kind: start
    on:
      kind: acme.thing.done
      connectionId: any
    inputs:
      title: event.payload.title
steps:
  - id: file_task
    kind: action
    action: task.create
    params:
      title: "Follow up on {{ inputs.title }}"
      description: Filed by an ingested event.
`;

/** Starts a set-up controller with the Acme plugin, whose loops run every 10 ms. */
const withIngestingController = (body: (controller: SetUpController) => Promise<void>) =>
  withSetUpController(body, [acmePlugin], {
    eventRoutingInterval: Duration.millis(10),
    ingestReconcileInterval: Duration.millis(10),
  });

describe("ingesting events from a plugin's event source", () => {
  it("emits an event from a Connection's feed, and the event starts a run", async () => {
    await withIngestingController(async (controller) => {
      const { base, token } = controller;
      const workflow = await createWorkflowOrFail(base, token, { source: THING_DONE_SOURCE });
      await enableWorkflow(base, token, workflow.id);

      const connectionId = await createConnection(base, token, "acme/acme", {
        token: ACCEPTED_TOKEN,
      });
      const runId = await waitUntil("the ingested event started a run", async () => {
        const page = await queryRuns(base, token, `workflowId=${workflow.id}`);
        return page.items[0]?.id;
      });
      const run = await waitForRunToFinish(base, token, runId);

      expect(run.status, JSON.stringify(run)).toBe("completed");
      expect(run.inputs).toEqual({ title: "Shipped" });
      if (run.origin.kind !== "trigger") expect.fail(`not a triggered run: ${JSON.stringify(run)}`);
      const event = await readEvent(base, token, run.origin.eventId);
      expect(event).toMatchObject({
        kind: "acme.thing.done",
        source: "acme",
        system: "acme",
        connectionId,
        dedupKey: "thing-1",
        occurredAt: "2026-09-01T10:00:00.000Z",
        url: "https://acme.example/things/1",
        payload: { title: "Shipped" },
      });
    });
  });

  it("marks a Connection whose credentials the source rejects as needing reauthorization", async () => {
    await withIngestingController(async (controller) => {
      const { base, token } = controller;
      const connectionId = await createConnection(base, token, "acme/acme", {
        token: "a-revoked-token",
      });

      const connection = await waitUntil("the Connection needs reauthorization", async () => {
        const read = await readConnection(controller.base, controller.token, connectionId);
        return read.status === "needs-reauth" ? read : undefined;
      });

      expect(connection.statusDetail).toBe("Acme rejected the token.");
    });
  });
});
