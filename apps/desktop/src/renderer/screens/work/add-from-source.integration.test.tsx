/**
 * Tests From a source in the Add to Work sheet against a stubbed controller:
 * the suggestions, the search that waits for typing to stop and throws away
 * an older answer, adding a thing (the row turning to a check, Return, the
 * undo), a pasted link moving the tab, and every state of the sheet's table.
 */
import { Suspense, type JSX } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createClient, queryKeys } from "@hercule/client-core";
import { buildPlace } from "@hercule/client-core/work/testing";
import type {
  EntitySearchReply,
  EntitySearchResult,
  EntitySuggestions,
  PluginDetail,
} from "@hercule/contract";
import { createQueryClient } from "../../app/query-client";
import {
  buildErrorBody,
  CONTROLLER_URL,
  holdAnswer,
  stubApi,
  type Call,
  type Handler,
} from "../../app/testing";
import { createUndoStack } from "../../app/undo-stack";
import { AddFromSource, type AddedThing } from "./add-from-source";
import { AddTaskSheet } from "./add-task-sheet";

const SEARCH_PATH = "GET /api/v1/external-entities/search";
const SUGGESTIONS_PATH = "GET /api/v1/external-entities/suggestions";
const ADD_PATH = "POST /api/v1/external-entities/add-to-work";
const ENTITY_ID = "01a06d02-7e00-7000-8000-000000000a01";
const TASK_ID = "01a06d02-7e00-7000-8000-000000000b01";

/** Returns an active plugin that declares one kind of thing, so the sheet offers it as a source. */
const buildSource = (id: string, displayName: string): PluginDetail => ({
  id,
  displayName,
  hostApi: 8,
  capabilities: ["entities"],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [],
  intake: { eventKinds: [], signalKinds: [] },
  entityKinds: [
    {
      word: `${id}/issue`,
      noun: "Issue",
      card: "compact",
      refPrefix: `${id}:issue:`,
      pace: "fast",
      patience: 24,
      identifier: "#{number}",
      person: null,
      owner: null,
      status: null,
      facts: [],
      reasons: {},
    },
  ],
});

const PLUGINS = [buildSource("relay", "Relay"), buildSource("acme", "Acme")];

const BASKET = buildPlace("relay:project:basket", "Basket rebuild", {
  kind: "relay/project",
  caption: "Relay project",
  status: { shape: "half", tone: "active", label: "In progress" },
  progress: { fraction: 0.4, done: 9, total: 22 },
});
const PRICING = buildPlace("relay:project:pricing", "Pricing rules", {
  kind: "relay/project",
  caption: "Relay project",
});

const buildResult = (overrides: Partial<EntitySearchResult> = {}): EntitySearchResult => ({
  ref: "relay:issue:301",
  kind: "relay/issue",
  noun: "Issue",
  identifier: "WEB-301",
  title: "Gift message is cut off at 140 characters",
  location: "Gift cards",
  status: { shape: "dashed", tone: "quiet", label: "Backlog" },
  standing: "new",
  ...overrides,
});
const WEB_302 = buildResult({
  ref: "relay:issue:302",
  identifier: "WEB-302",
  title: "Gift wrap option on the basket page",
  location: "Gift cards, Basket rebuild",
});

const buildReply = (overrides: Partial<EntitySearchReply> = {}): EntitySearchReply => ({
  source: "relay",
  outcome: "results",
  results: [buildResult(), WEB_302],
  incomplete: false,
  linkSources: [],
  ...overrides,
});

const SUGGESTIONS: EntitySuggestions = {
  suggestions: [
    {
      ref: "relay:issue:268",
      kind: "relay/issue",
      noun: "Issue",
      identifier: "WEB-268",
      title: "Basket badge does not update after undo",
      url: "https://relay.example/WEB-268",
      status: { shape: "dashed", tone: "quiet", label: "Todo" },
      alsoIn: [BASKET.ref],
    },
    {
      ref: "relay:issue:279",
      kind: "relay/issue",
      noun: "Issue",
      identifier: "WEB-279",
      title: "Multi-buy label wraps on small phones",
      url: "https://relay.example/WEB-279",
      status: { shape: "dashed", tone: "quiet", label: "Todo" },
      alsoIn: [PRICING.ref, BASKET.ref],
    },
  ],
  places: [PRICING],
  truncated: false,
};

const ADDED = {
  id: ENTITY_ID,
  taskId: TASK_ID,
  created: true,
  stage: "exploring",
  followed: true,
};

/** Returns the words a search call was asked for. */
const readSearchText = (call: Call): string | null => new URLSearchParams(call.search).get("text");

/** Lists the search calls, in the order they were sent. */
const listSearches = (calls: readonly Call[]): readonly Call[] =>
  calls.filter((call) => `${call.method} ${call.path}` === SEARCH_PATH);

interface Rendered {
  readonly calls: readonly Call[];
  readonly added: AddedThing[];
  readonly undoStack: ReturnType<typeof createUndoStack<unknown>>;
  readonly onFailed: ReturnType<typeof vi.fn<(message: string) => void>>;
  readonly onOpenTask: ReturnType<typeof vi.fn<(taskId: string) => void>>;
  readonly onClose: ReturnType<typeof vi.fn<() => void>>;
}

/** Renders the sheet with From a source, over a stubbed controller, and returns what it called. */
const renderSheet = ({
  handlers = {},
  opening = { sourceId: "relay" },
  isOffline = false,
  projectId = null,
  places = [BASKET, PRICING],
  queryClient = createQueryClient(),
}: {
  readonly handlers?: Readonly<Record<string, Handler>>;
  readonly opening?: { readonly sourceId?: string; readonly scopeRef?: string };
  readonly isOffline?: boolean;
  readonly projectId?: string | null;
  readonly places?: readonly (typeof BASKET)[];
  /** The cache the sheet reads through, when a test needs to fill or invalidate it. */
  readonly queryClient?: ReturnType<typeof createQueryClient>;
} = {}): Rendered => {
  const calls = stubApi({
    "GET /api/v1/plugins": { body: PLUGINS },
    [SUGGESTIONS_PATH]: { body: SUGGESTIONS },
    [SEARCH_PATH]: (call) => ({
      body: buildReply({ source: new URLSearchParams(call.search).get("source") ?? "relay" }),
    }),
    ...handlers,
  });
  const client = createClient({ baseUrl: CONTROLLER_URL, token: "bearer" });
  const added: AddedThing[] = [];
  const undoStack = createUndoStack<unknown>();
  undoStack.registerFallback({ buildPage: () => undefined, report: () => {} });
  const onFailed = vi.fn<(message: string) => void>();
  const onOpenTask = vi.fn<(taskId: string) => void>();
  const onClose = vi.fn<() => void>();
  const sheet = (): JSX.Element => (
    <QueryClientProvider client={queryClient}>
      <Suspense fallback={null}>
        <AddTaskSheet
          lane={{ id: "no-project", name: "No project", projectId: null }}
          result={null}
          onCreate={() => Promise.resolve()}
          onClose={onClose}
          onNewInitiative={() => {}}
          fromSource={
            <AddFromSource
              client={client}
              places={places}
              opening={opening}
              projectId={projectId}
              isOffline={isOffline}
              reserveGesture={undoStack.reserve}
              onAdded={(thing) => {
                added.push(thing);
              }}
              onFailed={onFailed}
              onOpenTask={onOpenTask}
            />
          }
        />
      </Suspense>
    </QueryClientProvider>
  );
  render(sheet());
  return { calls, added, undoStack, onFailed, onOpenTask, onClose };
};

/** Returns the search field, once the sheet has read the plugins. */
const findSearch = (name = "Search Relay, or paste a link"): Promise<HTMLInputElement> =>
  screen.findByRole<HTMLInputElement>("textbox", { name });

/** Returns what the scope select shows as chosen, such as "all of Relay". */
const readScopeChoice = (): string | undefined =>
  screen.getByRole<HTMLSelectElement>("combobox", { name: "Narrow the search" }).selectedOptions[0]
    ?.textContent;

/** Returns the row of the thing `identifier`. */
const getRow = (identifier: string): HTMLElement =>
  screen.getByText(identifier).closest("button") as HTMLElement;

describe("From a source: before anything is typed", () => {
  it("gives the search the keys, with one tab per source and the scope sentence", async () => {
    renderSheet();
    const search = await findSearch();

    expect(document.activeElement).toBe(search);
    expect(screen.getByRole("button", { name: "Relay", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Acme", pressed: false })).toBeTruthy();
    expect(screen.getByText("Searches")).toBeTruthy();
    expect(readScopeChoice()).toBe("all of Relay");
  });

  it("lists suggestions under a heading per place, a thing in two places once", async () => {
    renderSheet();

    expect(await screen.findByText("Basket rebuild")).toBeTruthy();
    expect(screen.getByText("Suggestions")).toBeTruthy();
    expect(
      screen.getByText(
        "Things that concern you, with no Task yet. Search to reach everything else.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Relay project · In progress")).toBeTruthy();
    expect(screen.getByText("9 of 22")).toBeTruthy();
    expect(screen.getAllByText("WEB-279")).toHaveLength(1);
    expect(screen.getByText("Also in Basket rebuild")).toBeTruthy();
  });

  it("opens on the context it is given, and reads the suggestions under it", async () => {
    const { calls } = renderSheet({ opening: { sourceId: "relay", scopeRef: BASKET.ref } });
    await findSearch();

    expect(
      screen.getByRole<HTMLSelectElement>("combobox", { name: "Narrow the search" }).value,
    ).toBe(BASKET.ref);
    expect(screen.getByText("in Relay")).toBeTruthy();
    await screen.findByText("WEB-268");
    const read = calls.find((call) => call.path === "/api/v1/external-entities/suggestions");
    expect(read?.search).toBe(`?contextRef=${encodeURIComponent(BASKET.ref)}`);
  });
});

describe("From a source: searching", () => {
  it("waits for typing to stop, then asks once, and shows bars and no spinner meanwhile", async () => {
    const held = holdAnswer();
    const { calls } = renderSheet({ handlers: { [SEARCH_PATH]: held.handler } });
    const user = userEvent.setup();

    await user.type(await findSearch(), "gift");
    expect(listSearches(calls)).toHaveLength(0);

    expect(await screen.findByText("Searching Relay…")).toBeTruthy();
    expect(document.querySelector(".add-bar")).toBeTruthy();
    expect(document.querySelector(".spin")).toBeNull();
    held.answer({ body: buildReply() });

    expect(await screen.findByText("From Relay")).toBeTruthy();
    expect(listSearches(calls)).toHaveLength(1);
    expect(readSearchText(listSearches(calls)[0]!)).toBe("gift");
  });

  it("heads the results, and says where each sits and whether Hercule has seen it", async () => {
    renderSheet({
      handlers: {
        [SEARCH_PATH]: () => ({
          body: buildReply({
            results: [
              buildResult(),
              buildResult({ ...WEB_302, standing: "on-work", taskId: TASK_ID }),
            ],
          }),
        }),
      },
    });
    const user = userEvent.setup();

    await user.type(await findSearch(), "gift");

    expect(await screen.findByText("2 results")).toBeTruthy();
    expect(within(getRow("WEB-301")).getByText("Gift cards · New to Hercule")).toBeTruthy();
    expect(within(getRow("WEB-301")).getByText("Backlog")).toBeTruthy();
    expect(within(getRow("WEB-302")).getByText("On Work")).toBeTruthy();
  });

  it("throws away the answer of an older search once a newer one was made", async () => {
    const older = holdAnswer();
    const handlers: Record<string, Handler> = {
      [SEARCH_PATH]: (call) =>
        readSearchText(call) === "gi"
          ? older.handler()
          : { body: buildReply({ results: [WEB_302] }) },
    };
    const { calls } = renderSheet({ handlers });
    const user = userEvent.setup();
    const search = await findSearch();

    await user.type(search, "gi");
    await waitFor(() => {
      expect(listSearches(calls)).toHaveLength(1);
    });
    await user.type(search, "ft");
    expect(await screen.findByText("WEB-302")).toBeTruthy();
    older.answer({ body: buildReply({ results: [buildResult()] }) });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(screen.queryByText("WEB-301")).toBeNull();
    expect(screen.getByText("WEB-302")).toBeTruthy();
  });

  it("cancels the request of an older search once a newer one was made", async () => {
    const older = holdAnswer();
    const handlers: Record<string, Handler> = {
      [SEARCH_PATH]: (call) =>
        readSearchText(call) === "gi" ? older.handler() : { body: buildReply() },
    };
    const { calls } = renderSheet({ handlers });
    const sentFetch = globalThis.fetch;
    const searchSignals: Array<AbortSignal | null | undefined> = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (url.includes("/external-entities/search")) searchSignals.push(init?.signal);
      return sentFetch(url, init);
    });
    const user = userEvent.setup();
    const search = await findSearch();

    await user.type(search, "gi");
    await waitFor(() => {
      expect(listSearches(calls)).toHaveLength(1);
    });
    expect(searchSignals[0]?.aborted).toBe(false);
    await user.type(search, "ft");
    await screen.findByText("WEB-301");

    expect(searchSignals[0]?.aborted).toBe(true);
  });

  it("goes back to the suggestions when the search is cleared", async () => {
    renderSheet();
    const user = userEvent.setup();
    const search = await findSearch();
    await user.type(search, "gift");
    await screen.findByText("From Relay");

    await user.clear(search);

    expect(await screen.findByText("Suggestions")).toBeTruthy();
  });

  it("searches a chosen context, and the whole source when the button says so", async () => {
    const { calls } = renderSheet({
      opening: { sourceId: "relay", scopeRef: BASKET.ref },
      handlers: {
        [SEARCH_PATH]: (call) => ({
          body: buildReply({
            ...(new URLSearchParams(call.search).has("scopeRef")
              ? { outcome: "no-match" as const, results: [] }
              : { results: [buildResult()] }),
          }),
        }),
      },
    });
    const user = userEvent.setup();

    await user.type(await findSearch(), "toaster");

    expect(await screen.findByText('Nothing in Basket rebuild matches "toaster".')).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Search all of Relay" }));
    expect(await screen.findByText("WEB-301")).toBeTruthy();
    const last = listSearches(calls).at(-1)!;
    expect(new URLSearchParams(last.search).has("scopeRef")).toBe(false);
    expect(readScopeChoice()).toBe("all of Relay");
  });

  it("says a source has nothing for the words", async () => {
    renderSheet({
      handlers: {
        [SEARCH_PATH]: () => ({ body: buildReply({ outcome: "no-match", results: [] }) }),
      },
    });
    const user = userEvent.setup();

    await user.type(await findSearch(), "toaster");

    expect(await screen.findByText('Relay has nothing that matches "toaster".')).toBeTruthy();
  });

  it("says a search failed, with the reason", async () => {
    renderSheet({
      handlers: {
        [SEARCH_PATH]: () => ({
          status: 500,
          body: buildErrorBody("internal", "The source did not answer."),
        }),
      },
    });
    const user = userEvent.setup();

    await user.type(await findSearch(), "toaster");

    expect(await screen.findByText(/^Could not search Relay\./)).toBeTruthy();
  });
});

describe("From a source: a pasted link", () => {
  const LINK = "https://acme.example/shop/issues/7";

  it("moves the tab to the source that reads the link", async () => {
    renderSheet({
      handlers: {
        [SEARCH_PATH]: () => ({
          body: buildReply({
            source: "acme",
            results: [buildResult({ ref: "acme:issue:7", kind: "acme/issue", identifier: "#7" })],
          }),
        }),
      },
    });
    const user = userEvent.setup();

    await user.click(await findSearch());
    await user.paste(LINK);

    expect(await screen.findByText("Found from the link")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Acme", pressed: true })).toBeTruthy();
    expect(screen.getByText("Reading this link from Acme.")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Search Acme, or paste a link" })).toBeTruthy();
  });

  it("asks once, though the tab moved", async () => {
    const { calls } = renderSheet({
      handlers: { [SEARCH_PATH]: () => ({ body: buildReply({ source: "acme" }) }) },
    });
    const user = userEvent.setup();

    await user.click(await findSearch());
    await user.paste(LINK);
    await screen.findByText("Found from the link");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(listSearches(calls)).toHaveLength(1);
  });

  it("says a link you cannot open, with a lock and no title", async () => {
    renderSheet({
      handlers: {
        [SEARCH_PATH]: () => ({
          body: buildReply({
            outcome: "inaccessible",
            results: [
              { ref: "relay:issue:301", kind: "relay/issue", noun: "Issue", standing: "new" },
            ],
          }),
        }),
      },
    });
    const user = userEvent.setup();

    await user.click(await findSearch());
    await user.paste(LINK);

    expect(await screen.findByText("You cannot open this Relay issue.")).toBeTruthy();
    expect(
      screen.getByText(/^It exists, but your connection to Relay has no access to it\./),
    ).toBeTruthy();
    expect(screen.queryByText("Gift message is cut off at 140 characters")).toBeNull();
  });

  it("says a link to nothing", async () => {
    renderSheet({
      handlers: {
        [SEARCH_PATH]: () => ({ body: buildReply({ outcome: "not-found", results: [] }) }),
      },
    });
    const user = userEvent.setup();

    await user.click(await findSearch());
    await user.paste(LINK);

    expect(
      await screen.findByText(
        "Relay found nothing at this link. It may be wrong, or the thing may be gone.",
      ),
    ).toBeTruthy();
  });

  it("names the sources that can read links when the link is from elsewhere", async () => {
    renderSheet({
      handlers: {
        [SEARCH_PATH]: () => ({
          body: buildReply({
            outcome: "unknown-link",
            results: [],
            linkSources: ["relay", "acme"],
          }),
        }),
      },
    });
    const user = userEvent.setup();

    await user.click(await findSearch());
    await user.paste("https://nowhere.example/thing/1");

    expect(
      await screen.findByText(
        "This link is not from a connected source. Hercule can read links from Relay, Acme.",
      ),
    ).toBeTruthy();
  });
});

describe("From a source: adding", () => {
  const searchFor = async (words = "gift"): Promise<ReturnType<typeof userEvent.setup>> => {
    const user = userEvent.setup();
    await user.type(await findSearch(), words);
    await screen.findByText("From Relay");
    return user;
  };

  it("turns the row into a check with its stage, in place, and tells the page", async () => {
    const { added } = renderSheet({ handlers: { [ADD_PATH]: { body: ADDED } } });
    const user = await searchFor();
    const rowsBefore = screen
      .getAllByRole("button")
      .filter((each) => each.dataset.ref !== undefined);

    await user.click(getRow("WEB-301"));

    await waitFor(() => {
      expect(within(getRow("WEB-301")).getByText("Exploring")).toBeTruthy();
    });
    expect((getRow("WEB-301") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole("button").filter((each) => each.dataset.ref !== undefined)).toEqual(
      rowsBefore,
    );
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      taskId: TASK_ID,
      line: "Added to Exploring. Hercule now follows WEB-301.",
    });
    // The keys are back in the search, ready for the next one.
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: /^Search Relay/ }));
  });

  it.each([
    ["joins the Project of the lane it was opened from", "01a06d02-7e00-7000-8000-000000000c01"],
    ["joins no Project when it was opened from outside a Project lane", null],
  ])("adds a Task that %s", async (_, projectId) => {
    const { calls } = renderSheet({ projectId, handlers: { [ADD_PATH]: { body: ADDED } } });
    const user = await searchFor();

    await user.click(getRow("WEB-301"));

    await waitFor(() => {
      expect(calls.some((call) => `${call.method} ${call.path}` === ADD_PATH)).toBe(true);
    });
    const sent = calls.find((call) => `${call.method} ${call.path}` === ADD_PATH);
    expect(sent?.body).toEqual(
      projectId === null ? { ref: "relay:issue:301" } : { ref: "relay:issue:301", projectId },
    );
  });

  it("turns the row into a check before the controller answers", async () => {
    const held = holdAnswer();
    renderSheet({ handlers: { [ADD_PATH]: held.handler } });
    const user = await searchFor();

    await user.click(getRow("WEB-301"));

    expect((getRow("WEB-301") as HTMLButtonElement).disabled).toBe(true);
    held.answer({ body: ADDED });
  });

  it("adds the first thing of the list on Return, and skips one that is on Work", async () => {
    const { calls } = renderSheet({
      handlers: {
        [SEARCH_PATH]: () => ({
          body: buildReply({
            results: [buildResult({ standing: "on-work", taskId: TASK_ID }), WEB_302],
          }),
        }),
        [ADD_PATH]: { body: { ...ADDED, followed: false } },
      },
    });
    const user = await searchFor();

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(
        calls.some((call) => call.method === "POST" && call.path.endsWith("/add-to-work")),
      ).toBe(true);
    });
    const sent = calls.find((call) => call.path.endsWith("/add-to-work"));
    expect(sent?.body).toEqual({ ref: WEB_302.ref });
  });

  it("searches the new words first when Return comes before typing has paused", async () => {
    const { calls } = renderSheet({ handlers: { [ADD_PATH]: { body: ADDED } } });
    const user = userEvent.setup();

    await user.type(await findSearch(), "gift{Enter}");

    await screen.findByText("From Relay");
    expect(calls.some((call) => call.path.endsWith("/add-to-work"))).toBe(false);
  });

  it("opens the Task of a thing that is on Work instead of adding it", async () => {
    const { onOpenTask, calls } = renderSheet({
      handlers: {
        [SEARCH_PATH]: () => ({
          body: buildReply({ results: [buildResult({ standing: "on-work", taskId: TASK_ID })] }),
        }),
      },
    });
    const user = await searchFor();

    await user.click(getRow("WEB-301"));

    expect(onOpenTask).toHaveBeenCalledExactlyOnceWith(TASK_ID);
    expect(calls.some((call) => call.path.endsWith("/add-to-work"))).toBe(false);
  });

  it("puts the row back and says why when the add fails", async () => {
    const { onFailed } = renderSheet({
      handlers: {
        [ADD_PATH]: { status: 409, body: buildErrorBody("conflict", "It changed. Try again.") },
      },
    });
    const user = await searchFor();

    await user.click(getRow("WEB-301"));

    await waitFor(() => {
      expect(onFailed).toHaveBeenCalledOnce();
    });
    expect(onFailed.mock.calls[0]?.[0]).toMatch(/^Could not add WEB-301: /);
    expect((getRow("WEB-301") as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not read the suggestions again while a row from them stays added", async () => {
    const { calls } = renderSheet({ handlers: { [ADD_PATH]: { body: ADDED } } });
    const user = userEvent.setup();
    await user.click(await screen.findByText("WEB-268"));
    await waitFor(() => {
      expect(within(getRow("WEB-268")).getByText("Exploring")).toBeTruthy();
    });

    expect(
      calls.filter((call) => call.path === "/api/v1/external-entities/suggestions"),
    ).toHaveLength(1);
    expect(screen.getByText("WEB-268")).toBeTruthy();
  });

  it("undoes the add, and the row can be added again", async () => {
    const { added, calls, undoStack } = renderSheet({
      handlers: {
        [ADD_PATH]: { body: ADDED },
        [`POST /api/v1/external-entities/${ENTITY_ID}/take-on/undo`]: {
          body: { undone: true },
        },
      },
    });
    const user = await searchFor();
    await user.click(getRow("WEB-301"));
    await waitFor(() => {
      expect(added).toHaveLength(1);
    });

    expect(await undoStack.undo()).toEqual({
      kind: "reversed",
      words: "Added WEB-301 to Work",
    });

    await waitFor(() => {
      expect((getRow("WEB-301") as HTMLButtonElement).disabled).toBe(false);
    });
    const undo = calls.find((call) => call.path.endsWith("/take-on/undo"));
    expect(undo?.body).toEqual({ taskId: TASK_ID });
  });

  it("waits for an add that has not answered when Undo is pressed, then undoes it", async () => {
    const held = holdAnswer();
    const { undoStack, calls } = renderSheet({
      handlers: {
        [ADD_PATH]: held.handler,
        [`POST /api/v1/external-entities/${ENTITY_ID}/take-on/undo`]: {
          body: { undone: true },
        },
      },
    });
    const user = await searchFor();
    await user.click(getRow("WEB-301"));

    const undone = undoStack.undo();
    expect(calls.some((call) => call.path.endsWith("/take-on/undo"))).toBe(false);
    held.answer({ body: ADDED });

    expect(await undone).toEqual({ kind: "reversed", words: "Added WEB-301 to Work" });
    expect(calls.find((call) => call.path.endsWith("/take-on/undo"))?.body).toEqual({
      taskId: TASK_ID,
    });
  });

  it("says why the undo was refused, and keeps the row added", async () => {
    const { added, undoStack } = renderSheet({
      handlers: {
        [ADD_PATH]: { body: ADDED },
        [`POST /api/v1/external-entities/${ENTITY_ID}/take-on/undo`]: {
          body: { undone: false, reason: "A Thread has started on this Task." },
        },
      },
    });
    const user = await searchFor();
    await user.click(getRow("WEB-301"));
    await waitFor(() => {
      expect(added).toHaveLength(1);
    });

    expect(await undoStack.undo()).toEqual({
      kind: "failed",
      words: "Added WEB-301 to Work",
      reason: "A Thread has started on this Task.",
    });

    expect((getRow("WEB-301") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says a thing that already had a Task is on Work, with nothing to undo", async () => {
    const { added, undoStack } = renderSheet({
      handlers: {
        [ADD_PATH]: { body: { ...ADDED, created: false, stage: "building", followed: false } },
      },
    });
    const user = await searchFor();

    await user.click(getRow("WEB-301"));

    await waitFor(() => {
      expect(added).toHaveLength(1);
    });
    expect(added[0]).toMatchObject({ line: "WEB-301 is already on Work, in Building." });
    expect(added[0]?.wasCreated).toBe(false);
    // The add reserved a place on the stack, and gave it up once it made no Task.
    expect(await undoStack.undo()).toEqual({ kind: "empty" });
  });
});

describe("From a source: the suggestions and the contexts", () => {
  it("keeps the suggestions as shown, with the check in place, when a read that was on its way returns without the added thing", async () => {
    const queryClient = createQueryClient();
    const later = holdAnswer();
    let reads = 0;
    renderSheet({
      queryClient,
      handlers: {
        [SUGGESTIONS_PATH]: () => (++reads === 1 ? { body: SUGGESTIONS } : later.handler()),
        [ADD_PATH]: { body: ADDED },
      },
    });
    const user = userEvent.setup();
    await screen.findByText("WEB-268");
    // A live push starts a read, and it is still on its way when the user adds.
    void queryClient.invalidateQueries({ queryKey: queryKeys.entitySuggestions() });
    await waitFor(() => {
      expect(reads).toBe(2);
    });

    await user.click(getRow("WEB-268"));
    later.answer({ body: { ...SUGGESTIONS, suggestions: [SUGGESTIONS.suggestions[1]!] } });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(within(getRow("WEB-268")).getByText("Exploring")).toBeTruthy();
    expect(screen.getByText("WEB-279")).toBeTruthy();
  });

  it("shows the live suggestions again when the add fails", async () => {
    const queryClient = createQueryClient();
    const later = holdAnswer();
    let reads = 0;
    renderSheet({
      queryClient,
      handlers: {
        [SUGGESTIONS_PATH]: () => (++reads === 1 ? { body: SUGGESTIONS } : later.handler()),
        [ADD_PATH]: { status: 500, body: buildErrorBody("internal", "The source did not answer.") },
      },
    });
    const user = userEvent.setup();
    await screen.findByText("WEB-268");
    void queryClient.invalidateQueries({ queryKey: queryKeys.entitySuggestions() });
    await waitFor(() => {
      expect(reads).toBe(2);
    });

    await user.click(getRow("WEB-268"));
    later.answer({ body: { ...SUGGESTIONS, suggestions: [SUGGESTIONS.suggestions[1]!] } });

    await waitFor(() => {
      expect(screen.queryByText("WEB-268")).toBeNull();
    });
    expect(screen.getByText("WEB-279")).toBeTruthy();
  });
});

describe("From a source: offline", () => {
  it("says the source cannot be searched, and typing only narrows the suggestions", async () => {
    const { calls } = renderSheet({ isOffline: true });
    const user = userEvent.setup();

    await user.type(await findSearch(), "badge");

    expect(
      screen.getByText(
        "You are offline, so Relay cannot be searched. Typing only narrows the suggestions.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Things that concern you, with no Task yet.")).toBeTruthy();
    await screen.findByText("WEB-268");
    expect(screen.queryByText("WEB-279")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(listSearches(calls)).toHaveLength(0);
  });

  it("fails an add and says so, keeping nothing to send later", async () => {
    const { onFailed, calls } = renderSheet({
      isOffline: true,
      handlers: {
        [ADD_PATH]: () => {
          throw new TypeError("Failed to fetch");
        },
      },
    });
    const user = userEvent.setup();

    await user.click(await screen.findByText("WEB-268"));

    await waitFor(() => {
      expect(onFailed).toHaveBeenCalledExactlyOnceWith(
        "You are offline, so WEB-268 was not added. Try again when you are back.",
      );
    });
    expect((getRow("WEB-268") as HTMLButtonElement).disabled).toBe(false);
    expect(calls.filter((call) => call.path.endsWith("/add-to-work"))).toHaveLength(1);
  });
});

describe("From a source: the tabs and Esc", () => {
  it("searches the other source's words when its tab is picked", async () => {
    const { calls } = renderSheet();
    const user = userEvent.setup();
    await user.type(await findSearch(), "gift");
    await screen.findByText("From Relay");

    await user.click(screen.getByRole("button", { name: "Acme" }));

    expect(
      await screen.findByRole("textbox", { name: "Search Acme, or paste a link" }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        listSearches(calls).map((call) => new URLSearchParams(call.search).get("source")),
      ).toEqual(["relay", "acme"]);
    });
  });

  it("clears what is typed on the first Esc and closes the sheet on the second", async () => {
    const { onClose } = renderSheet();
    const user = userEvent.setup();
    const search = await findSearch();
    await user.type(search, "gift");

    await user.keyboard("{Escape}");
    expect(search.value).toBe("");
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("draws nothing when no plugin is a source", async () => {
    renderSheet({ handlers: { "GET /api/v1/plugins": { body: [] } } });

    await screen.findByRole("textbox", { name: "New Task" });
    expect(screen.queryByText("From a source")).toBeNull();
  });
});
