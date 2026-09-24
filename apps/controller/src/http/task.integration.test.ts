/**
 * Tests `GET /tasks` over a real socket: the order of a listing, and how it
 * pages.
 *
 * Both orders are tested through the API only: a request sets `sort` or
 * `text`, and the tests check only the response.
 */
import { describe, expect, it } from "vitest";
import type { Task } from "@hercule/contract";
import { completeSetup, get, post, send, withServer } from "./testing";

interface TaskPage {
  readonly items: ReadonlyArray<Task>;
  readonly nextCursor?: string;
}

const listTasks = async (base: string, token: string, query = ""): Promise<TaskPage> => {
  const response = await get(base, `/api/v1/tasks${query}`, token);
  expect(response.status).toBe(200);
  return (await response.json()) as TaskPage;
};

const createTask = async (
  base: string,
  token: string,
  fields: { readonly title: string; readonly description?: string },
): Promise<Task> => {
  const response = await post(base, "/api/v1/tasks", { description: "", ...fields }, token);
  expect(response.status).toBe(200);
  return (await response.json()) as Task;
};

const listTitles = (page: TaskPage): ReadonlyArray<string> => page.items.map((task) => task.title);

/** Waits long enough that the next write gets a later millisecond. */
const waitForNextMillisecond = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 10));

/** Pages through a listing to its end, and returns every id it returned. */
const walkPages = async (
  base: string,
  token: string,
  query: string,
  limit: number,
  between?: () => Promise<void>,
): Promise<ReadonlyArray<string>> => {
  const seen: Array<string> = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const suffix = cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const result = await listTasks(base, token, `${query}&limit=${String(limit)}${suffix}`);
    expect(result.items.length).toBeLessThanOrEqual(limit);
    seen.push(...result.items.map((task) => task.id));
    cursor = result.nextCursor;
    if (cursor === undefined) return seen;
    if (page === 0 && between !== undefined) await between();
  }
  throw new Error("the listing never ended");
};

describe("the order of a task listing", () => {
  it("defaults to updatedAt desc, and follows an explicit sort", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const first = await createTask(base, token, { title: "first" });
      await waitForNextMillisecond();
      await createTask(base, token, { title: "second" });
      await waitForNextMillisecond();
      await createTask(base, token, { title: "third" });

      expect(listTitles(await listTasks(base, token))).toEqual(["third", "second", "first"]);

      // Editing the oldest task moves it to the top of the default order,
      // which only `updatedAt desc` would do.
      await waitForNextMillisecond();
      const touched = await send("PATCH", base, `/api/v1/tasks/${first.id}`, {
        body: { description: "touched" },
        token,
      });
      expect(touched.status).toBe(200);
      expect(listTitles(await listTasks(base, token))).toEqual(["first", "third", "second"]);

      // The edit does not change `createdAt`, so ascending creation order is
      // still the order the tasks were written in.
      expect(listTitles(await listTasks(base, token, "?sort=createdAt:asc"))).toEqual([
        "first",
        "second",
        "third",
      ]);
      expect(listTitles(await listTasks(base, token, "?sort=createdAt:desc"))).toEqual([
        "third",
        "second",
        "first",
      ]);
    });
  });

  it("rejects a sort field the operation does not declare", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const response = await get(base, "/api/v1/tasks?sort=deletedAt", token);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });
    });
  });

  it("rejects a search that also sets a sort, and names both fields", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      await createTask(base, token, { title: "a searchable task" });

      const response = await get(base, "/api/v1/tasks?text=searchable&sort=updatedAt", token);
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: {
          code: string;
          details: { issues: ReadonlyArray<{ path: ReadonlyArray<string> }> };
        };
      };
      expect(body.error.code).toBe("validation");
      const paths = body.error.details.issues.flatMap((issue) => issue.path);
      expect(paths).toContain("sort");
      expect(paths).toContain("text");

      // The search alone is fine; only the combination is rejected.
      const alone = await listTasks(base, token, "?text=searchable");
      expect(listTitles(alone)).toEqual(["a searchable task"]);
    });
  });

  it("orders a search by relevance rather than by updatedAt", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      // Written first, so `updatedAt desc` would put it last. It is the best
      // match: short, and containing the word four times.
      await createTask(base, token, { title: "widget", description: "widget widget widget" });
      await waitForNextMillisecond();
      for (const name of ["second", "third"]) {
        await createTask(base, token, {
          title: `a ${name} note that mentions a widget once`,
          description:
            "a long body about many unrelated things, written so the match is thin: " +
            "scheduling, runners, workspaces, checkouts, providers and their adapters",
        });
        await waitForNextMillisecond();
      }

      const relevance = await listTasks(base, token, "?text=widget");
      expect(relevance.items).toHaveLength(3);
      expect(relevance.items[0]?.title).toBe("widget");

      // That is not the order the same three come back in without a search.
      expect(listTitles(await listTasks(base, token))[0]).not.toBe("widget");
    });
  });
});

describe("paging a task listing", () => {
  it("pages through seven rows at limit 2, returning each exactly once, with and without text", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const created: Array<string> = [];
      for (let index = 0; index < 7; index++) {
        const task = await createTask(base, token, {
          title: `sortable task ${String(index)}`,
          description: "each of these holds the word sortable",
        });
        created.push(task.id);
        await waitForNextMillisecond();
      }

      const plain = await walkPages(base, token, "?", 2);
      expect(plain).toHaveLength(7);
      expect(new Set(plain)).toEqual(new Set(created));

      const searched = await walkPages(base, token, "?text=sortable", 2);
      expect(searched).toHaveLength(7);
      expect(new Set(searched)).toEqual(new Set(created));
    });
  });

  it("pages by keyset without a search, so a row written while paging repeats nothing", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const created: Array<string> = [];
      for (let index = 0; index < 7; index++) {
        const task = await createTask(base, token, { title: `task ${String(index)}` });
        created.push(task.id);
        await waitForNextMillisecond();
      }

      // A task written after the first page goes to the top of
      // `updatedAt desc`, so offset paging would return a row it had already
      // returned. Keyset paging continues from the boundary and never does.
      let intruder = "";
      const seen = await walkPages(base, token, "?", 2, async () => {
        await waitForNextMillisecond();
        intruder = (await createTask(base, token, { title: "written mid-walk" })).id;
      });

      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).not.toContain(intruder);
      expect(new Set(seen)).toEqual(new Set(created));
    });
  });
});
