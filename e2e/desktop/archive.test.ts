/**
 * Tests archiving a Done Thread in the packaged app, signed in to a real
 * controller: the Archive button on the Done shelf asks first, the Thread
 * then leaves the sidebar and the shelf's count drops, and the controller
 * records the Thread as archived, never resumable, and hands its workspace
 * back to the automatic cleanup. The cleanup sweep itself runs every ten
 * minutes and has no shorter setting in the binary, so its removal of an
 * archived workspace is tested beside the sweep, in
 * `archived-removal.integration.test.ts`.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { expect, it } from "vitest";
import { arrangeFleet, openSignedIn } from "./harness";

it("archives a Done Thread from the shelf: it leaves the sidebar and its workspace goes back to the automatic cleanup", async () => {
  const { url, fleet, client, waitForStatus } = await arrangeFleet();
  const runner = await fleet.enlistRunner("studio");
  const [thread] = await fleet.spawnThreads(1, {
    runner,
    workspace: { kind: "ephemeral", checkouts: [] },
  });
  await waitForStatus(thread!.id, "busy");
  runner.endSession(thread!.id, "crash");
  await waitForStatus(thread!.id, "exited");
  await client.session.markDone({ payload: { sessionIds: [thread!.id] } });
  const workspaceId = (await client.session.read({ params: { id: thread!.id } })).workspaceId!;
  // A Thread's workspace is kept until the user says otherwise.
  expect((await client.workspace.read({ params: { id: workspaceId } })).retentionPolicy).toBe(
    "manual",
  );
  const { page } = await openSignedIn(url);

  await page.getByRole("button", { name: "Done 1" }).click();
  const row = page.locator(".side-item", {
    has: page.getByRole("link", { name: "Thread 1, done" }),
  });
  await row.getByRole("button", { name: "Archive" }).click();
  const dialog = page.getByRole("dialog", { name: "Archive Thread 1?" });
  await dialog.getByRole("button", { name: "Keep it" }).waitFor();
  // Nothing is archived until the user confirms.
  expect((await client.session.read({ params: { id: thread!.id } })).archived).toBeUndefined();
  await dialog.getByRole("button", { name: "Archive" }).click();

  await page.getByRole("status").getByText("Archived").waitFor();
  await page.getByRole("link", { name: "Thread 1, done" }).waitFor({ state: "detached" });
  await page.getByRole("button", { name: /^Done \d+$/ }).waitFor({ state: "detached" });
  const archived = await client.session.read({ params: { id: thread!.id } });
  expect(archived.archived?.by).toBe("user");
  expect(archived.done).toBeDefined();
  expect(archived.resumable).toBe(false);
  await expect
    .poll(
      async () => (await client.workspace.read({ params: { id: workspaceId } })).retentionPolicy,
    )
    .toBe("automatic");
});
