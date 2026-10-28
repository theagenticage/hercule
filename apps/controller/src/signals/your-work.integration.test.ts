/**
 * Tests `GET /signals/your-work` over a real socket, against the real
 * services: the route is reached beside `/signals/:id`, the reply decodes as
 * `SignalYourWork`, and a caller without a token is refused. The Tasks and
 * signals are written through their repositories, as a handoff leaves them.
 */
import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { SignalYourWork } from "@hercule/contract";
import { inTransaction } from "../db/testing";
import { completeSetup, get, withServer } from "../http/testing";
import { taskRepository } from "../tasks";
import { signalRepository } from "./repository";

const CONNECTION_ID = "0199e0e7-0000-7000-8000-00000000c001";
const SIGNAL_ID = "0199e0e7-0005-7000-8000-000000000001";
const REF = "github:pr:acme/api#1";
const AT = "2026-10-20T10:00:00.000Z";

describe("signal.queryYourWork", () => {
  it("returns the open Tasks of the open signals, reached beside /signals/:id", async () => {
    await withServer(async ({ base, sql }) => {
      const token = await completeSetup(base);
      const taskId = await Effect.runPromise(
        Effect.gen(function* () {
          const signals = yield* signalRepository;
          const tasks = yield* taskRepository;
          yield* signals.insert(
            {
              id: SIGNAL_ID,
              kind: "github/review-requested",
              origin: { type: "event", eventId: 1, connectionId: CONNECTION_ID, threadRef: REF },
              title: "Review requested",
              priority: "normal",
              blocks: [],
              actions: [],
              match: {},
              status: "open",
              createdAt: AT,
            },
            [],
          );
          yield* tasks.insert({
            title: "Other",
            description: "",
            status: "done",
            priority: "normal",
            labels: [],
            projectId: undefined,
            provenance: [{ ref: REF }],
            at: AT,
            actor: "user",
          });
          return (yield* tasks.insert({
            title: "Review the bump",
            description: "A long description Your work never reads.",
            status: "in-progress",
            priority: "normal",
            labels: [],
            projectId: undefined,
            provenance: [{ ref: REF }],
            at: AT,
            actor: "user",
          })).id;
        }).pipe(inTransaction, Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie),
      );

      const response = await get(base, "/api/v1/signals/your-work", token);

      expect(response.status, await response.clone().text()).toBe(200);
      expect(Schema.decodeUnknownSync(SignalYourWork)(await response.json())).toEqual({
        tasks: [
          {
            id: taskId,
            title: "Review the bump",
            status: "in-progress",
            updatedAt: AT,
            signalIds: [SIGNAL_ID],
          },
        ],
      });
    });
  });

  it("returns no Tasks when no signal is open", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);

      const response = await get(base, "/api/v1/signals/your-work", token);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ tasks: [] });
    });
  });

  it("refuses a caller with no token", async () => {
    await withServer(async ({ base }) => {
      const response = await get(base, "/api/v1/signals/your-work");

      expect(response.status).toBe(401);
    });
  });
});
