/**
 * Tests taking several things on as one piece of work, over HTTP against a
 * real controller, on real rows (spec 11, `externalEntity.takeOnTogether` and
 * `externalEntity.undoTakeOnTogether`; spec 20 section 9):
 *
 * - one Task for things that have none, and its undo;
 * - joining the Task that things share, and its undo;
 * - things on different Tasks, a thing that is unknown, a body that is too
 *   short: each refused with nothing written.
 */
import { describe, expect, it } from "vitest";
import type { EntityTakeOnTogetherResult, EntityUndoTakeOnResult, Task } from "@hercule/contract";
import { get, post, readErrorBody } from "../http/testing";
import {
  arrangeThing,
  countRows,
  CHANGE_KIND,
  createAccount,
  TICKET_KIND,
  withNorthwind,
} from "./testing";

const TAKE_ON = "/api/v1/external-entities/take-on";
const UNDO = "/api/v1/external-entities/take-on/undo";

describe("takeOnTogether", () => {
  it("makes one Task for things that have none, and the undo deletes it", async () => {
    await withNorthwind(async (full) => {
      const { base, token } = full;
      const account = await createAccount(full, "bot");
      const change = await arrangeThing(full, {
        kind: CHANGE_KIND,
        key: "northwind/web#7",
        title: "Retry webhooks",
        accounts: [account],
      });
      const ticket = await arrangeThing(full, {
        kind: TICKET_KIND,
        key: "WEB-1",
        title: "Webhooks fail",
        accounts: [account],
      });

      const response = await post(
        base,
        TAKE_ON,
        { ids: [ticket.id, change.id], title: "Fix webhooks" },
        token,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const made = (await response.json()) as EntityTakeOnTogetherResult;
      expect(made).toMatchObject({ created: true, added: [ticket.id, change.id] });

      const task = (await (await get(base, `/api/v1/tasks/${made.taskId}`, token)).json()) as Task;
      expect(task.title).toBe("Fix webhooks");
      expect(await countRows(full, "tasks")).toBe(1);

      const undo = await post(base, UNDO, made, token);
      expect(undo.status).toBe(200);
      expect((await undo.json()) as EntityUndoTakeOnResult).toEqual({ undone: true });
      expect((await get(base, `/api/v1/tasks/${made.taskId}`, token)).status).toBe(404);
    });
  });

  it("joins the Task one of the things already has, and the undo leaves that Task", async () => {
    await withNorthwind(async (controller) => {
      const { base, token } = controller;
      const account = await createAccount(controller, "bot");
      const arranged = [
        await arrangeThing(controller, {
          kind: TICKET_KIND,
          key: "WEB-1",
          title: "One",
          accounts: [account],
        }),
        await arrangeThing(controller, {
          kind: TICKET_KIND,
          key: "WEB-2",
          title: "Two",
          accounts: [account],
        }),
      ];
      const first = await post(
        base,
        `/api/v1/external-entities/${arranged[0]!.id}/take-on`,
        {},
        token,
      );
      const earlier = (await first.json()) as { readonly taskId: string };

      const response = await post(
        base,
        TAKE_ON,
        { ids: arranged.map((thing) => thing.id), title: "Both" },
        token,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const joined = (await response.json()) as EntityTakeOnTogetherResult;
      expect(joined).toMatchObject({
        taskId: earlier.taskId,
        created: false,
        added: [arranged[1]!.id],
        taken: [arranged[1]!.id],
      });

      const undo = await post(base, UNDO, joined, token);
      expect((await undo.json()) as EntityUndoTakeOnResult).toEqual({ undone: true });
      expect((await get(base, `/api/v1/tasks/${earlier.taskId}`, token)).status).toBe(200);
      expect(await countRows(controller, "tasks")).toBe(1);
    });
  });

  it("refuses things on two different Tasks, naming them, and writes nothing", async () => {
    await withNorthwind(async (controller) => {
      const { base, token } = controller;
      const account = await createAccount(controller, "bot");
      const things = [
        await arrangeThing(controller, {
          kind: TICKET_KIND,
          key: "WEB-1",
          title: "One",
          accounts: [account],
        }),
        await arrangeThing(controller, {
          kind: TICKET_KIND,
          key: "WEB-2",
          title: "Two",
          accounts: [account],
        }),
      ];
      for (const thing of things) {
        await post(base, `/api/v1/external-entities/${thing.id}/take-on`, {}, token);
      }

      const response = await post(
        base,
        TAKE_ON,
        { ids: things.map((thing) => thing.id), title: "Both" },
        token,
      );
      const refusal = await readErrorBody(response);
      expect(response.status).toBe(409);
      expect(refusal.code).toBe("invalid_state");
      expect(refusal.message).toContain("One");
      expect(refusal.message).toContain("Two");
      expect(await countRows(controller, "tasks")).toBe(2);
    });
  });

  it("refuses an unknown id, and fewer than two ids, with nothing written", async () => {
    await withNorthwind(async (controller) => {
      const { base, token } = controller;
      const account = await createAccount(controller, "bot");
      const thing = await arrangeThing(controller, {
        kind: TICKET_KIND,
        key: "WEB-1",
        title: "One",
        accounts: [account],
      });
      const unknown = await post(
        base,
        TAKE_ON,
        { ids: [thing.id, "0199e0e7-9999-7000-8000-000000000000"], title: "x" },
        token,
      );
      expect(unknown.status).toBe(404);
      const tooFew = await post(base, TAKE_ON, { ids: [thing.id], title: "x" }, token);
      expect(tooFew.status).toBe(400);
      expect(await countRows(controller, "tasks")).toBe(0);
    });
  });
});
