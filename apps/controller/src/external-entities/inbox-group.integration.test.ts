/**
 * Tests reading the group of one thing over HTTP against a real controller
 * (spec 11, `externalEntity.readInboxGroup`; spec 20 section 8.6):
 *
 * - two linked things on the Inbox are one group, with the link that joins them;
 * - a thing on the Inbox that is linked to nothing is a group of one;
 * - a thing that is not on the Inbox is refused with `not_found`.
 */
import { describe, expect, it } from "vitest";
import type { InboxGroupDetail } from "@hercule/contract";
import { post, readErrorBody } from "../http/testing";
import { arrangeThing, createAccount, TICKET_KIND, withNorthwind } from "./testing";

const GROUP = "/api/v1/external-entities/inbox/group";

describe("readInboxGroup", () => {
  it("returns the group of a thing, its members and the link between them", async () => {
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
      // A live Task puts a thing on the Inbox.
      for (const thing of things) {
        await post(base, `/api/v1/external-entities/${thing.id}/take-on`, {}, token);
      }
      const linked = await post(
        base,
        "/api/v1/external-entities/links",
        { fromRef: things[0]!.ref, toRef: things[1]!.ref },
        token,
      );
      expect(linked.status, await linked.clone().text()).toBe(200);

      const response = await post(base, GROUP, { ref: things[1]!.ref }, token);
      expect(response.status, await response.clone().text()).toBe(200);
      const group = (await response.json()) as InboxGroupDetail;
      expect(group.members.map((member) => member.ref).sort()).toEqual(
        things.map((thing) => thing.ref).sort(),
      );
      expect(group.links).toEqual([
        {
          fromRef: things[0]!.ref,
          toRef: things[1]!.ref,
          claim: { type: "person", actor: "user" },
          hasPersonClaim: true,
        },
      ]);
      expect(group.complete).toBe(true);
    });
  });

  it("returns a group of one for a thing linked to nothing on the Inbox", async () => {
    await withNorthwind(async (controller) => {
      const { base, token } = controller;
      const account = await createAccount(controller, "bot");
      const thing = await arrangeThing(controller, {
        kind: TICKET_KIND,
        key: "WEB-1",
        title: "Alone",
        accounts: [account],
      });
      await post(base, `/api/v1/external-entities/${thing.id}/take-on`, {}, token);

      const response = await post(base, GROUP, { ref: thing.ref }, token);
      expect(response.status, await response.clone().text()).toBe(200);
      const group = (await response.json()) as InboxGroupDetail;
      expect(group).toMatchObject({
        labelRef: thing.ref,
        label: "Alone",
        links: [],
        complete: true,
      });
      expect(group.members.map((member) => member.ref)).toEqual([thing.ref]);
    });
  });

  it("refuses a thing that is not on the Inbox", async () => {
    await withNorthwind(async (controller) => {
      const { base, token } = controller;
      const response = await post(base, GROUP, { ref: "northwind:ticket:NOPE-1" }, token);
      expect(response.status).toBe(404);
      expect((await readErrorBody(response)).code).toBe("not_found");
    });
  });
});
