/**
 * Tests taking several things on as one piece of work, over HTTP against a
 * real controller, on real rows (spec 11, `externalEntity.takeOnTogether` and
 * `externalEntity.undoTakeOnTogether`; spec 20 section 9):
 *
 * - one Task for things that have none, and its undo;
 * - joining the Task that things share, and its undo;
 * - things on different Tasks, a thing that is unknown, a body that is too
 *   short: each refused with nothing written;
 * - the record the call keeps: its undo is asked by `recordId`, a repeat gets
 *   the same answer, a row changed since refuses with nothing changed, an
 *   unknown record is `not_found`;
 * - linking and unlinking a set of things in one call.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type {
  EntityLinkResult,
  EntityTakeOnTogetherResult,
  EntityUndoTakeOnResult,
  EntityUnlinkResult,
  Task,
} from "@hercule/contract";
import { uuidFromString, withTransaction } from "../db";
import { get, post, readErrorBody } from "../http/testing";
import {
  arrangeThing,
  countRows,
  CHANGE_KIND,
  createAccount,
  TICKET_KIND,
  withNorthwind,
} from "./testing";
import type { SetUpController } from "../workflows/testing";

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
      expect(made).toMatchObject({ created: true, added: 2, taken: 2 });
      expect(await countRows(full, "entity_take_ons")).toBe(1);

      const task = (await (await get(base, `/api/v1/tasks/${made.taskId}`, token)).json()) as Task;
      expect(task.title).toBe("Fix webhooks");
      expect(await countRows(full, "tasks")).toBe(1);

      const undo = await post(base, UNDO, { recordId: made.recordId }, token);
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
        added: 1,
        taken: 1,
      });

      const undo = await post(base, UNDO, { recordId: joined.recordId }, token);
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

describe("the record of a take-on together", () => {
  /** Two tickets, the first already on a Task, taken on together so the call joins that Task. */
  const arrangeJoin = async (controller: SetUpController) => {
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
    const earlier = (await (
      await post(base, `/api/v1/external-entities/${things[0]!.id}/take-on`, {}, token)
    ).json()) as { readonly taskId: string };
    const response = await post(
      base,
      TAKE_ON,
      { ids: things.map((thing) => thing.id), title: "Both" },
      token,
    );
    const joined = (await response.json()) as EntityTakeOnTogetherResult;
    return { things, earlier, joined };
  };

  const countLinks = async (controller: SetUpController, taskId: string): Promise<number> =>
    Effect.runPromise(
      Effect.map(
        controller.harness.sql<{ readonly n: number }>`
          SELECT count(*) AS n FROM task_entity_links WHERE task_id = ${uuidFromString(taskId)}`,
        (rows) => rows[0]!.n,
      ),
    );

  it("answers a repeat of the undo with the first answer, and does not undo again", async () => {
    await withNorthwind(async (controller) => {
      const { base, token } = controller;
      const { earlier, joined } = await arrangeJoin(controller);
      expect(await countLinks(controller, earlier.taskId)).toBe(2);

      const first = await post(base, UNDO, { recordId: joined.recordId }, token);
      expect((await first.json()) as EntityUndoTakeOnResult).toEqual({ undone: true });
      expect(await countLinks(controller, earlier.taskId)).toBe(1);

      const repeat = await post(base, UNDO, { recordId: joined.recordId }, token);
      expect(repeat.status).toBe(200);
      expect((await repeat.json()) as EntityUndoTakeOnResult).toEqual({ undone: true });
      expect(await countLinks(controller, earlier.taskId)).toBe(1);
    });
  });

  it("refuses with nothing changed when a link was written again since", async () => {
    await withNorthwind(async (controller) => {
      const { base, token } = controller;
      const { earlier, joined, things } = await arrangeJoin(controller);
      await Effect.runPromise(
        Effect.orDie(
          withTransaction(
            controller.harness.sql,
            controller.harness.sql`
              UPDATE task_entity_links SET linked_at = '2030-01-01T00:00:00.000Z'
              WHERE task_id = ${uuidFromString(earlier.taskId)} AND ref = ${things[1]!.ref}`,
          ),
        ),
      );

      const response = await post(base, UNDO, { recordId: joined.recordId }, token);
      expect(response.status).toBe(200);
      const refused = (await response.json()) as EntityUndoTakeOnResult;
      expect(refused.undone).toBe(false);
      expect(refused.reason).toContain("changed");
      expect(await countLinks(controller, earlier.taskId)).toBe(2);
    });
  });

  it("refuses an unknown record id with not_found", async () => {
    await withNorthwind(async (controller) => {
      const { base, token } = controller;
      const response = await post(
        base,
        UNDO,
        { recordId: "0199e0e7-9999-7000-8000-000000000000" },
        token,
      );
      expect(response.status).toBe(404);
      expect((await readErrorBody(response)).code).toBe("not_found");
    });
  });
});

describe("linking and unlinking a set of things", () => {
  const LINK = "/api/v1/external-entities/links";
  const UNLINK = "/api/v1/external-entities/links/remove";

  it("links the set in one call, answers the claims it wrote, and unlinks per pair", async () => {
    await withNorthwind(async (controller) => {
      const { base, token } = controller;
      const account = await createAccount(controller, "bot");
      const things = await Promise.all(
        ["WEB-1", "WEB-2", "WEB-3"].map((key) =>
          arrangeThing(controller, { kind: TICKET_KIND, key, title: key, accounts: [account] }),
        ),
      );
      const [from, second, third] = things;

      const first = await post(base, LINK, { fromRef: from!.ref, toRefs: [second!.ref] }, token);
      expect(((await first.json()) as EntityLinkResult).created).toEqual([second!.ref]);

      const set = await post(
        base,
        LINK,
        { fromRef: from!.ref, toRefs: [second!.ref, third!.ref] },
        token,
      );
      expect(set.status, await set.clone().text()).toBe(200);
      expect(((await set.json()) as EntityLinkResult).created).toEqual([third!.ref]);

      const removed = await post(
        base,
        UNLINK,
        { fromRef: from!.ref, toRefs: [third!.ref, second!.ref, "northwind:ticket:NONE"] },
        token,
      );
      expect(((await removed.json()) as EntityUnlinkResult).results).toEqual([
        { toRef: third!.ref, removed: true },
        { toRef: second!.ref, removed: true },
        { toRef: "northwind:ticket:NONE", removed: false },
      ]);
    });
  });

  it("refuses a set with one bad target, and an empty set, with nothing linked", async () => {
    await withNorthwind(async (controller) => {
      const { base, token } = controller;
      const account = await createAccount(controller, "bot");
      const from = await arrangeThing(controller, {
        kind: TICKET_KIND,
        key: "WEB-1",
        title: "One",
        accounts: [account],
      });
      const bad = await post(
        base,
        LINK,
        { fromRef: from.ref, toRefs: ["northwind:ticket:OK-1", from.ref] },
        token,
      );
      expect(bad.status).toBe(409);
      expect((await readErrorBody(bad)).code).toBe("invalid_state");
      expect((await post(base, LINK, { fromRef: from.ref, toRefs: [] }, token)).status).toBe(400);
      const check = await post(
        base,
        UNLINK,
        { fromRef: from.ref, toRefs: ["northwind:ticket:OK-1"] },
        token,
      );
      expect(((await check.json()) as EntityUnlinkResult).results).toEqual([
        { toRef: "northwind:ticket:OK-1", removed: false },
      ]);
    });
  });
});
