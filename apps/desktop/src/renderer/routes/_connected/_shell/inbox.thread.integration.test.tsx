/**
 * Tests the Inbox's start-thread dialog through the rendered app: N opens it
 * on the things with the Investigate words, the matched project and its
 * reason, an unpicked project that holds the send and opens the menu on ⌘↩,
 * No project, the starters, a chip left out, a send that makes the Task and
 * the thread, a refused send that keeps the words, unsent words kept for the
 * same things, a refusal on a thing that has a Task, and the focus going to
 * the empty state when the last row leaves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  EntityPeer,
  InboxGroup,
  InboxGroupDetail,
  InboxThing,
  ProjectMatch,
} from "@hercule/contract";
import {
  buildErrorBody,
  buildThreadHandlers,
  FIXTURE_ACCOUNT,
  FIXTURE_MODEL_PROFILE,
  readFieldText,
  setVisibility,
  SIDEBAR_FIXTURE,
  stubElementSize,
  stubIntersectionObserver,
  THREAD_FIXTURES,
  type Call,
  type Handler,
} from "../../../app/testing";
import {
  BASKET,
  LOYALTY,
  SLOTS,
  SLOTS_AND_LOYALTY,
  answerGroupedWith,
  defaultInbox,
  openInbox,
  QUERY_PATH,
  request,
  type FakeInbox,
} from "./-inbox.testing";

beforeEach(() => {
  stubIntersectionObserver();
  stubElementSize(400, 600);
});

afterEach(() => {
  cleanup();
  setVisibility("visible");
  localStorage.clear();
});

const MATCH = "POST /api/v1/external-entities/match-project";
const SPAWN = "POST /api/v1/sessions";
const [WEBSHOP] = SIDEBAR_FIXTURE.projects as [(typeof SIDEBAR_FIXTURE.projects)[number]];
const [WEBSHOP_REPOSITORY] = SIDEBAR_FIXTURE.resources;
/** The thread the stubbed controller starts. */
const STARTED = THREAD_FIXTURES.finished;
const OWN_WORDS = "Check the slot cache first.";

const MATCHED: ProjectMatch = {
  kind: "matched",
  projectId: WEBSHOP.id,
  resourceId: WEBSHOP_REPOSITORY!.id,
  thing: { id: SLOTS.id, identifier: SLOTS.identifier },
};

const callsTo = (calls: readonly Call[], path: string): readonly Call[] =>
  calls.filter((call) => `${call.method} ${call.path}` === path);

const readUndoLine = (): string => document.querySelector(".ib .undo-line")?.textContent ?? "";

/** Opens the Inbox with three review requests; the controller matches `match` and starts `STARTED`. */
const open = async (
  match: ProjectMatch | Handler = MATCHED,
  change: (inbox: FakeInbox) => void = () => undefined,
  handlers: Readonly<Record<string, Handler>> = {},
) => {
  const inbox = defaultInbox();
  change(inbox);
  const opened = await openInbox(inbox, {
    "GET /api/v1/provider-accounts": { body: [FIXTURE_ACCOUNT] },
    "GET /api/v1/model-profiles": { body: [FIXTURE_MODEL_PROFILE] },
    ...buildThreadHandlers(STARTED),
    [MATCH]: typeof match === "function" ? match : { body: match },
    [SPAWN]: { body: STARTED.session },
    ...handlers,
  });
  await screen.findAllByRole("treeitem");
  return { ...opened, inbox, user: userEvent.setup() };
};

/** Presses N on the current row and returns the dialog once it is open. */
const openDialog = async (user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
  await user.keyboard("n");
  return screen.findByRole("dialog", { name: "Start a thread" });
};

const readMessage = (dialog: HTMLElement): string =>
  readFieldText(within(dialog).getByRole("textbox", { name: "Message" }));

describe("opening the dialog", () => {
  it("opens on N with the thing as a chip and the Investigate words", async () => {
    const { user } = await open();

    const dialog = await openDialog(user);

    expect(within(dialog).getByText(SLOTS.identifier)).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLInputElement>("The Task’s name").value).toBe(
      SLOTS.title,
    );
    expect(
      within(dialog).getByRole("radio", { name: "Investigate" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(readMessage(dialog)).toMatch(/^Look into this and tell me what is going on/);
  });

  it("opens on every selected thing, and starts the message with their number", async () => {
    const { user } = await open();
    await user.keyboard("{Control>}a{/Control}");

    const dialog = await openDialog(user);

    expect(within(dialog).getAllByRole("button", { name: /^Leave .* out$/ })).toHaveLength(3);
    expect(readMessage(dialog)).toMatch(/^Look into these 3 and tell me/);
  });

  it("opens from the button on a row", async () => {
    const { user } = await open();

    await user.click(
      within(screen.getByRole("treeitem", { name: new RegExp(LOYALTY.title) })).getByRole(
        "button",
        { name: /Start a thread/ },
      ),
    );

    const dialog = await screen.findByRole("dialog", { name: "Start a thread" });
    expect(within(dialog).getByText(LOYALTY.identifier)).toBeTruthy();
  });

  it("refuses a thing that is on a Task already, says why on the undo line and opens nothing", async () => {
    const held = request(4, "Held by a Task", "Ana", {
      taskId: "01a1b576-c999-7000-8000-000000000902",
    });
    const { user } = await open(MATCHED, (inbox) => {
      inbox.lists.waits = [held];
    });

    await user.keyboard("n");

    await waitFor(() => {
      expect(readUndoLine()).toContain("G goes to its Task");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the project", () => {
  it("shows the matched project with the reason behind it", async () => {
    const { user } = await open();

    const dialog = await openDialog(user);

    await within(dialog).findByRole("button", { name: `Project ${WEBSHOP.name}` });
    expect(dialog.querySelector(".thread-dialog-why")?.textContent).toContain(
      `${WEBSHOP.name} because ${SLOTS.identifier} is in`,
    );
  });

  it("holds the send while no project is picked, and ⌘↩ opens the project menu", async () => {
    const { user, calls } = await open({ kind: "none" });
    const dialog = await openDialog(user);
    await within(dialog).findByRole("button", { name: "Choose a project" });
    // The menu is a browser popover, which jsdom lacks: the pick's own click is what ⌘↩ makes.
    let opened = 0;
    within(dialog)
      .getByRole("button", { name: "Choose a project" })
      .addEventListener("click", () => {
        opened += 1;
      });

    expect(
      within(dialog).getByRole("button", { name: "Start thread" }).getAttribute("aria-disabled"),
    ).toBe("true");
    await user.click(within(dialog).getByRole("textbox", { name: "Message" }));
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(callsTo(calls, SPAWN)).toHaveLength(0);
    expect(opened).toBe(1);
  });

  it("starts with no project, with approval-required access and no workspace", async () => {
    const { user, calls } = await open({ kind: "none" });
    const dialog = await openDialog(user);
    await within(dialog).findByRole("button", { name: "Choose a project" });

    await user.click(
      await within(dialog).findByRole("menuitemradio", {
        name: /No project: no code, no checkout/,
        hidden: true,
      }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Start thread" }));

    await waitFor(() => {
      expect(callsTo(calls, SPAWN)).toHaveLength(1);
    });
    const body = callsTo(calls, SPAWN)[0]!.body as Record<string, unknown>;
    expect(body.accessMode).toBe("approval-required");
    expect(body.projectId).toBeUndefined();
    expect(body.workspace).toBeUndefined();
  });
});

describe("writing", () => {
  it("replaces the words when a starter is picked, and calls typed words your own", async () => {
    const { user } = await open();
    const dialog = await openDialog(user);

    await user.click(within(dialog).getByRole("radio", { name: "Fix" }));
    await waitFor(() => {
      expect(readMessage(dialog)).toMatch(/^Fix this and open a pull request/);
    });
    await user.click(within(dialog).getByRole("textbox", { name: "Message" }));
    await user.keyboard(" Quickly.");

    expect(
      within(dialog).getByRole("radio", { name: "Your own words" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("reads the match again when a chip is left out, and rewrites the words that are still a starter's", async () => {
    const { user, calls } = await open();
    await user.keyboard("{Control>}a{/Control}");
    const dialog = await openDialog(user);
    await within(dialog).findByRole("button", { name: `Project ${WEBSHOP.name}` });
    const before = callsTo(calls, MATCH).length;

    await user.click(
      within(dialog).getByRole("button", { name: `Leave ${BASKET.identifier} out` }),
    );

    await waitFor(() => {
      expect(callsTo(calls, MATCH)).toHaveLength(before + 1);
    });
    expect((callsTo(calls, MATCH).at(-1)!.body as { ids: string[] }).ids).toHaveLength(2);
    await waitFor(() => {
      expect(readMessage(dialog)).toMatch(/^Look into these 2 and tell me/);
    });
  });
});

describe("sending", () => {
  /** Types `OWN_WORDS` over the starter's words and presses ⌘↩ in the field. */
  const writeAndSend = async (
    user: ReturnType<typeof userEvent.setup>,
    dialog: HTMLElement,
  ): Promise<void> => {
    await within(dialog).findByRole("button", { name: `Project ${WEBSHOP.name}` });
    await user.click(within(dialog).getByRole("radio", { name: "Your own words" }));
    await user.click(within(dialog).getByRole("textbox", { name: "Message" }));
    await user.keyboard(OWN_WORDS);
    await user.keyboard("{Control>}{Enter}{/Control}");
  };

  it("makes the Task and the thread in one request, once, then shows the started thread and opens it", async () => {
    const { user, calls, router } = await open();
    const dialog = await openDialog(user);

    await writeAndSend(user, dialog);

    const started = await screen.findByRole("dialog", { name: "Thread started" });
    expect(callsTo(calls, SPAWN)).toHaveLength(1);
    const body = callsTo(calls, SPAWN)[0]!.body as {
      prompt: string;
      newTask: { title: string; entityIds: string[] };
      context: unknown;
      dedupKey: string;
      projectId: string;
    };
    expect(body.newTask).toEqual({ title: SLOTS.title, entityIds: [SLOTS.id] });
    expect(body.prompt).toBe(OWN_WORDS);
    expect(body.context).toEqual([{ kind: "entity", entityId: SLOTS.id }]);
    expect(body.dedupKey.length).toBeGreaterThan(0);
    expect(body.projectId).toBe(WEBSHOP.id);
    expect(within(started).getByText(/^Thread started · webshop · /)).toBeTruthy();
    expect(within(started).getByText("It is on this Task now")).toBeTruthy();
    expect(readUndoLine()).toContain("Started a thread on");
    expect(readUndoLine()).not.toContain("Undo");

    await user.click(within(started).getByRole("button", { name: "Open the thread" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${STARTED.session.id}`);
    });
  });

  it("starts once on ⌘↩ from the name's input too", async () => {
    const { user, calls } = await open();
    const dialog = await openDialog(user);
    await within(dialog).findByRole("button", { name: `Project ${WEBSHOP.name}` });

    await user.click(within(dialog).getByLabelText("The Task’s name"));
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    await screen.findByRole("dialog", { name: "Thread started" });
    expect(callsTo(calls, SPAWN)).toHaveLength(1);
  });

  it("keeps the dialog and the words when the controller refuses, and retries with the same dedup key", async () => {
    let refuse = true;
    const { user, calls } = await open(MATCHED, undefined, {
      [SPAWN]: () =>
        refuse
          ? {
              status: 409,
              body: buildErrorBody("invalid_state", "moss is at its limit of 4 sessions"),
            }
          : { body: STARTED.session },
    });
    const dialog = await openDialog(user);

    await writeAndSend(user, dialog);

    await within(dialog).findByText(/was not started as a thread: moss is at its limit/);
    expect(readMessage(dialog)).toBe(OWN_WORDS);
    refuse = false;
    await user.click(within(dialog).getByRole("button", { name: "Start thread" }));

    await screen.findByRole("dialog", { name: "Thread started" });
    const [first, second] = callsTo(calls, SPAWN).map(
      (call) => (call.body as { dedupKey: string }).dedupKey,
    );
    expect(second).toBe(first);
  });

  it("refuses an empty name with the composer's error and sends nothing", async () => {
    const { user, calls } = await open();
    const dialog = await openDialog(user);
    await within(dialog).findByRole("button", { name: `Project ${WEBSHOP.name}` });

    await user.clear(within(dialog).getByLabelText("The Task’s name"));
    await user.click(within(dialog).getByRole("button", { name: "Start thread" }));

    await within(dialog).findByText("Give the Task a name first.");
    expect(callsTo(calls, SPAWN)).toHaveLength(0);
  });
});

describe("closing", () => {
  it("keeps edited words and says so, and N on the same things opens them again", async () => {
    const { user } = await open();
    let dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("radio", { name: "Your own words" }));
    await user.click(within(dialog).getByRole("textbox", { name: "Message" }));
    await user.keyboard(OWN_WORDS);

    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(readUndoLine()).toContain("Your words are kept. N on the same things opens them again.");
    dialog = await openDialog(user);
    expect(readMessage(dialog)).toBe(OWN_WORDS);
  });

  it("keeps nothing of a dialog closed without a change", async () => {
    const { user } = await open();
    const dialog = await openDialog(user);

    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(readUndoLine()).not.toContain("Your words are kept");
  });

  it("gives the focus back to the current row", async () => {
    const { user } = await open();
    const dialog = await openDialog(user);

    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("treeitem", { name: new RegExp(SLOTS.title) }),
      );
    });
  });

  it("puts the focus on the empty state's heading when the thread took the last row and the list is read again", async () => {
    const { user, inbox, live } = await open(MATCHED, (list) => {
      list.lists.waits = [SLOTS];
    });
    const dialog = await openDialog(user);
    await within(dialog).findByRole("button", { name: `Project ${WEBSHOP.name}` });
    await user.click(within(dialog).getByRole("button", { name: "Start thread" }));
    const started = await screen.findByRole("dialog", { name: "Thread started" });

    // The controller no longer lists a thing that is on a Task for "Someone waits on me".
    inbox.lists.waits = [];
    live.pushInvalidation("externalEntity", [SLOTS.id]);
    await user.click(within(started).getByRole("button", { name: "Back to the Inbox" }));

    const heading = await screen.findByRole("heading", { name: /Nobody waits on you|All clear/ });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
  });
});

describe("review fixes", () => {
  const SECOND_REPOSITORY = {
    ...WEBSHOP_REPOSITORY!,
    id: "01a1b576-c999-7000-8000-0000000000b2",
    canonicalRemote: "github.com/acme/storefront-api",
    projectIds: [WEBSHOP.id],
  };
  const startWith = async (user: ReturnType<typeof userEvent.setup>) => {
    const dialog = await openDialog(user);
    await within(dialog).findByRole("button", { name: `Project ${WEBSHOP.name}` });
    return dialog;
  };

  it("starts in the repository the evidence is in, with the main workspace setting", async () => {
    const { user, calls } = await open(
      { ...MATCHED, resourceId: SECOND_REPOSITORY.id },
      undefined,
      {
        "GET /api/v1/resources": { body: { items: [WEBSHOP_REPOSITORY, SECOND_REPOSITORY] } },
        "GET /api/v1/settings": {
          body: { controller: {}, user: { "thread.workspace": "primary" } },
        },
      },
    );
    const dialog = await startWith(user);

    await user.click(within(dialog).getByRole("button", { name: "Start thread" }));

    await waitFor(() => {
      expect(callsTo(calls, SPAWN)).toHaveLength(1);
    });
    const body = callsTo(calls, SPAWN)[0]!.body as {
      workspace: { kind: string; resourceId: string };
    };
    expect(body.workspace).toMatchObject({ kind: "primary", resourceId: SECOND_REPOSITORY.id });
  });

  it("sends nothing while the message is blank", async () => {
    const { user, calls } = await open();
    const dialog = await startWith(user);

    await user.click(within(dialog).getByRole("radio", { name: "Your own words" }));
    await user.click(within(dialog).getByRole("textbox", { name: "Message" }));
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(callsTo(calls, SPAWN)).toHaveLength(0);
    expect(
      within(dialog).getByRole("button", { name: "Start thread" }).getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("says the lookup failed rather than that nothing points at a repository, and a chosen project still sends", async () => {
    const { user, calls } = await open(() => ({
      status: 500,
      body: buildErrorBody("internal", "match is down"),
    }));
    const dialog = await openDialog(user);

    await waitFor(() => {
      expect(dialog.querySelector(".thread-dialog-why")?.textContent).toContain(
        "Could not look up the project: match is down",
      );
    });
    expect(within(dialog).getByRole("button", { name: "Try the lookup again" })).toBeTruthy();
    expect(dialog.textContent).not.toContain("Nothing here points at a repository");
    await user.click(
      await within(dialog).findByRole("menuitemradio", { name: /^webshop/, hidden: true }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Start thread" }));

    await waitFor(() => {
      expect(callsTo(calls, SPAWN)).toHaveLength(1);
    });
  });

  it("refuses to send while offline, in the composer, and keeps the draft", async () => {
    const { user, calls, live } = await open();
    const dialog = await startWith(user);

    live.drop();
    await user.click(within(dialog).getByRole("button", { name: "Start thread" }));

    await within(dialog).findByText(/You are offline, so that was not done/);
    expect(callsTo(calls, SPAWN)).toHaveLength(0);
  });

  it("reopens a draft whose send was attempted on a thing that now shows as held, and retries with its dedup key", async () => {
    const plain = request(4, "Held by a Task", "Ana");
    let lost = true;
    const { user, calls, inbox, context } = await open(
      MATCHED,
      (list) => {
        list.lists.waits = [plain];
      },
      {
        [SPAWN]: () => {
          if (lost) throw new Error("the connection was lost");
          return { body: STARTED.session };
        },
      },
    );
    let dialog = await openDialog(user);
    await within(dialog).findByRole("button", { name: `Project ${WEBSHOP.name}` });
    await user.click(within(dialog).getByRole("button", { name: "Start thread" }));
    await within(dialog).findByText(/was not started as a thread/);
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    // The controller made the Task while the reply was lost, so the row now shows as held.
    lost = false;
    inbox.lists.waits = [{ ...plain, taskId: "01a1b576-c999-7000-8000-000000000902" }];
    await context.queryClient.invalidateQueries();
    await waitFor(() => {
      expect(readUndoLine()).not.toContain("G goes to its Task");
    });

    dialog = await openDialog(user);
    await within(dialog).findByRole("button", { name: `Project ${WEBSHOP.name}` });
    await user.click(within(dialog).getByRole("button", { name: "Start thread" }));

    await screen.findByRole("dialog", { name: "Thread started" });
    const [first, second] = callsTo(calls, SPAWN).map((call) => call.body as { dedupKey: string });
    expect(second!.dedupKey).toBe(first!.dedupKey);
  });

  it("keeps a failed draft on close even though nothing was edited", async () => {
    const { user } = await open(MATCHED, undefined, {
      [SPAWN]: {
        status: 409,
        body: buildErrorBody("invalid_state", "moss is at its limit of 4 sessions"),
      },
    });
    const dialog = await openDialog(user);
    await within(dialog).findByRole("button", { name: `Project ${WEBSHOP.name}` });
    await user.click(within(dialog).getByRole("button", { name: "Start thread" }));
    await within(dialog).findByText(/was not started as a thread/);

    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(readUndoLine()).toContain("Your words are kept");
    });
  });

  it("does not render the Inbox screen again for what is typed in the dialog", async () => {
    const { user, context } = await open();
    const dialog = await openDialog(user);
    await within(dialog).findByRole("button", { name: `Project ${WEBSHOP.name}` });
    // The screen reads its account scope on every render.
    const reads = vi.spyOn(context.controller!.accountScopes, "read");
    await user.click(within(dialog).getByRole("radio", { name: "Your own words" }));
    await user.click(within(dialog).getByRole("textbox", { name: "Message" }));

    await user.keyboard(OWN_WORDS);

    expect(readMessage(dialog)).toBe(OWN_WORDS);
    expect(reads).not.toHaveBeenCalled();
  });

  it("tries again with the same request and key after a lost reply, when the project is gone", async () => {
    let lost = true;
    let match: ProjectMatch = MATCHED;
    const { user, calls, context } = await open(() => ({ body: match }), undefined, {
      [SPAWN]: () => {
        if (lost) throw new Error("the connection was lost");
        return { body: STARTED.session };
      },
    });
    let dialog = await openDialog(user);
    await within(dialog).findByRole("button", { name: `Project ${WEBSHOP.name}` });
    await user.click(within(dialog).getByRole("button", { name: "Start thread" }));
    await within(dialog).findByText(/was not started as a thread/);
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    // The controller committed the thread, and the Project has since gone.
    lost = false;
    match = { kind: "none" };
    await context.queryClient.invalidateQueries();

    dialog = await openDialog(user);
    await within(dialog).findByRole("button", { name: "Choose a project" });
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));

    await screen.findByRole("dialog", { name: "Thread started" });
    const [first, second] = callsTo(calls, SPAWN).map((call) => call.body as { dedupKey: string });
    expect(callsTo(calls, SPAWN)).toHaveLength(2);
    expect(second).toEqual(first);
  });

  it("shows a refresh of the match that failed, and does not keep the old project", async () => {
    let fail = false;
    const { user, calls, context } = await open(() =>
      fail ? { status: 500, body: buildErrorBody("internal", "match is down") } : { body: MATCHED },
    );
    const dialog = await startWith(user);

    fail = true;
    await context.queryClient.invalidateQueries();

    await within(dialog).findByRole("button", { name: "Try the lookup again" });
    expect(dialog.querySelector(".thread-dialog-why")?.textContent).toContain(
      "Could not look up the project: match is down",
    );
    await user.click(within(dialog).getByRole("button", { name: "Start thread" }));
    expect(callsTo(calls, SPAWN)).toHaveLength(0);
  });

  it("refuses to send while the Inbox says offline, also when a reconnect is pending", async () => {
    let hold = false;
    const { user, calls, context, live } = await open(MATCHED, undefined, {
      "POST /api/v1/auth/ws-ticket": () =>
        hold ? new Promise<never>(() => undefined) : { body: { ticket: "ws-ticket" } },
    });
    const dialog = await startWith(user);
    const statuses: string[] = [];
    context.controller!.live.onStatus((status) => statuses.push(status));

    hold = true;
    live.drop();
    await waitFor(() => {
      expect(statuses.at(-1)).toBe("connecting");
    });
    await user.click(within(dialog).getByRole("button", { name: "Start thread" }));

    await within(dialog).findByText(/You are offline, so that was not done/);
    expect(callsTo(calls, SPAWN)).toHaveLength(0);
  });
});

describe("a group of linked things", () => {
  const GROUP: InboxGroup = { ...SLOTS_AND_LOYALTY, label: "Slots and loyalty rework" };
  const answerGrouped = answerGroupedWith([GROUP]);

  const buildPeer = (thing: InboxThing): EntityPeer => ({
    id: thing.id,
    ref: thing.ref,
    kind: thing.kind,
    noun: thing.noun,
    identifier: thing.identifier,
    title: thing.title,
    url: thing.url,
    yours: false,
    restricted: false,
  });
  /** What the group pane reads: the two linked by the user. */
  const GROUP_DETAIL: InboxGroupDetail = {
    labelRef: SLOTS.ref,
    label: GROUP.label,
    members: [buildPeer(SLOTS), buildPeer(LOYALTY)],
    links: [
      {
        fromRef: SLOTS.ref,
        toRef: LOYALTY.ref,
        claim: { type: "person", actor: "user" },
        hasPersonClaim: true,
      },
    ],
    complete: true,
  };

  /** Opens the Inbox with Slots and Loyalty linked into one group. */
  const openWithGroup = () => {
    let inbox: FakeInbox;
    return open(MATCHED, (made) => (inbox = made), {
      [QUERY_PATH]: (call: Call) => answerGrouped(inbox, call),
      "POST /api/v1/external-entities/inbox/group": { body: GROUP_DETAIL },
    });
  };

  /** Starts the thread in the open dialog and checks the Task holds both members under the label. */
  const sendAndExpectGroupTask = async (
    user: ReturnType<typeof userEvent.setup>,
    dialog: HTMLElement,
    calls: readonly Call[],
  ) => {
    expect(within(dialog).getByText(SLOTS.identifier)).toBeTruthy();
    expect(within(dialog).getByText(LOYALTY.identifier)).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLInputElement>("The Task’s name").value).toBe(
      GROUP.label,
    );
    await within(dialog).findByRole("button", { name: `Project ${WEBSHOP.name}` });
    await user.click(within(dialog).getByRole("button", { name: "Start thread" }));
    await screen.findByRole("dialog", { name: "Thread started" });
    expect(callsTo(calls, SPAWN)).toHaveLength(1);
    const body = callsTo(calls, SPAWN)[0]!.body as {
      newTask: { title: string; entityIds: string[] };
    };
    expect(body.newTask).toEqual({ title: GROUP.label, entityIds: [SLOTS.id, LOYALTY.id] });
  };

  it("starts one Task for both members, named by the label, on N", async () => {
    const { user, calls } = await openWithGroup();
    await screen.findByRole("treeitem", { name: /Linked group, 2 things/ });

    const dialog = await openDialog(user);

    await sendAndExpectGroupTask(user, dialog, calls);
  });

  it("does the same from the group row's Start a thread button", async () => {
    const { user, calls } = await openWithGroup();
    const row = await screen.findByRole("treeitem", { name: /Linked group, 2 things/ });

    await user.click(within(row).getByRole("button", { name: /Start a thread/ }));

    const dialog = await screen.findByRole("dialog", { name: "Start a thread" });
    await sendAndExpectGroupTask(user, dialog, calls);
  });

  it("does the same from the group pane's Start a thread on all 2", async () => {
    const { user, calls } = await openWithGroup();
    await screen.findByRole("treeitem", { name: /Linked group, 2 things/ });

    await user.click(await screen.findByRole("button", { name: "Start a thread on all 2" }));

    const dialog = await screen.findByRole("dialog", { name: "Start a thread" });
    await sendAndExpectGroupTask(user, dialog, calls);
  });
});
