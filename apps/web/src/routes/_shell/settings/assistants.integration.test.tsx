/**
 * Tests for Settings > Assistants against a stubbed controller: the list of
 * assistants, the form that edits the selected one, "New assistant",
 * deleting an assistant after a confirmation, and the memory editor.
 *
 * The stub keeps the assistants and their memory in memory, so a read after
 * a write returns what the writes left. Its memory writes enforce the caps,
 * the shrink guard and the expected version with the contract's own rules,
 * as the controller does.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  chooseMemoryCap,
  countCharacters,
  MEMORY_CORE,
  requiresShrinkConfirmation,
  type Assistant,
  type MemoryDocument,
  type MemoryWriteInput,
  type Profile,
  type ProviderAccount,
} from "@hercule/contract";
import {
  buildErrorBody,
  expectInDocumentOrder,
  readPageText,
  renderApp,
  stubApi,
  type Answer,
  type Call,
  type Handler,
} from "../../../app/testing";

const AT = "2026-09-25T09:00:00.000Z";

const buildAccount = (id: string, label: string | null): ProviderAccount => ({
  id,
  providerId: "anthropic/anthropic",
  kind: "subscription-per-machine",
  label,
  identity: null,
  planLabel: null,
  defaultHarnessId: "claude-code/claude-code",
  expiresAt: null,
  snapshots: [],
  createdAt: AT,
  updatedAt: AT,
});

const ACCOUNT_PERSONAL = buildAccount("01a06d02-1000-7000-8000-000000000001", null);
const ACCOUNT_WORK = buildAccount("01a06d02-1000-7000-8000-000000000002", "work");
const ACCOUNTS: readonly ProviderAccount[] = [ACCOUNT_PERSONAL, ACCOUNT_WORK];

const buildProfile = (id: string, name: string): Profile => ({
  id,
  name,
  grants: [],
  shipped: true,
  createdAt: AT,
  updatedAt: AT,
});

const PROFILE_ASSISTANT = buildProfile("01a06d02-3000-7000-8000-000000000001", "assistant");
const PROFILE_UNRESTRICTED = buildProfile("01a06d02-3000-7000-8000-000000000002", "unrestricted");
const PROFILES: readonly Profile[] = [PROFILE_ASSISTANT, PROFILE_UNRESTRICTED];

const buildAssistant = (
  fields: Pick<Assistant, "id" | "name" | "systemPrompt" | "mainConversationId"> &
    Partial<Assistant>,
): Assistant => ({
  providerAccountId: ACCOUNT_PERSONAL.id,
  harnessId: null,
  permissionProfileId: PROFILE_ASSISTANT.id,
  accessMode: "auto-accept-edits",
  // No model, so a form without a Model field never has one to send.
  model: null,
  disallowedTools: ["edit"],
  unenforced: [],
  heartbeat: { enabled: false, schedule: "0 7-23 * * *", prompt: "Check in.", target: "web" },
  rotation: { contextFraction: 0.7, maxContextTokens: 200000, dailyAt: "04:00" },
  reply: "turn-end",
  createdAt: AT,
  updatedAt: AT,
  ...fields,
});

const ADA = buildAssistant({
  id: "01a06d02-a000-7000-8000-000000000001",
  mainConversationId: "01a06d02-c000-7000-8000-000000000001",
  name: "Ada",
  systemPrompt: "You are Ada. Answer briefly.",
});

const BOB = buildAssistant({
  id: "01a06d02-a000-7000-8000-000000000002",
  mainConversationId: "01a06d02-c000-7000-8000-000000000002",
  name: "Bob",
  systemPrompt: "You are Bob. Answer at length.",
  providerAccountId: ACCOUNT_WORK.id,
  permissionProfileId: PROFILE_UNRESTRICTED.id,
  accessMode: "auto",
  reply: "segments",
});

/** What the controller returns for `assistant.create { name: "Hercule" }`. */
const CREATED = buildAssistant({
  id: "01a06d02-a000-7000-8000-000000000003",
  mainConversationId: "01a06d02-c000-7000-8000-000000000003",
  name: "Hercule",
  systemPrompt: "You are a personal assistant running inside the user's own controller.",
});

const buildMemoryDocument = (
  name: string,
  gist: string,
  body: string,
  version = 1,
): MemoryDocument => ({
  name,
  gist,
  size: countCharacters(body),
  body,
  version,
  updatedAt: AT,
});

/** Ada's memory on arrival: her core note and two topics. */
const ADA_MEMORY: readonly MemoryDocument[] = [
  buildMemoryDocument(MEMORY_CORE, "", "Rogier lives in Amsterdam. Prefers short answers."),
  buildMemoryDocument(
    "decisions",
    "What we decided about the build, and why each choice was made over the others",
    "Use SQLite.\nShip one binary.",
  ),
  // Over 1,000 characters, so the shrink guard protects it.
  buildMemoryDocument("people", "", "Ines runs the infrastructure team. ".repeat(40)),
];

/**
 * The document names the stub answers for, per assistant. The stub matches
 * exact paths, so a name a test writes must be listed here.
 */
const MEMORY_NAMES = [MEMORY_CORE, "decisions", "people", "travel"] as const;

const QUESTION_ADA =
  "Delete Ada? Its conversation and messages are deleted. Its sessions and transcripts stay.";

/**
 * Returns stub routes for a controller that holds `initial` as its
 * assistants. Reads, creates, updates and deletes all act on the same list.
 * `extra` replaces any route, for a test that needs a write refused.
 */
const buildController = (
  initial: readonly Assistant[],
  extra: Readonly<Record<string, Handler>> = {},
): Readonly<Record<string, Handler>> => {
  let list = initial;
  const missing = { status: 404, body: buildErrorBody("not_found", "no such assistant") };
  const perAssistant = [...initial, CREATED].flatMap(({ id }): Array<[string, Handler]> => {
    const path = `/api/v1/assistants/${id}`;
    const read = (): Assistant | undefined => list.find((each) => each.id === id);
    return [
      [
        `GET ${path}`,
        () => {
          const current = read();
          return current === undefined ? missing : { body: current };
        },
      ],
      [
        `PATCH ${path}`,
        (call) => {
          const current = read();
          if (current === undefined) return missing;
          const updated = { ...current, ...(call.body as Partial<Assistant>) };
          list = list.map((each) => (each.id === id ? updated : each));
          return { body: updated };
        },
      ],
      [
        `DELETE ${path}`,
        () => {
          list = list.filter((each) => each.id !== id);
          return { body: {} };
        },
      ],
    ];
  });
  const memory = new Map<string, readonly MemoryDocument[]>(
    [...initial, CREATED].map(({ id }) => [
      id,
      id === ADA.id ? ADA_MEMORY : [buildMemoryDocument(MEMORY_CORE, "", "")],
    ]),
  );
  const perMemory = [...initial, CREATED].flatMap(({ id }): Array<[string, Handler]> => {
    const readDocuments = (): readonly MemoryDocument[] => memory.get(id) ?? [];
    const documentRoutes = MEMORY_NAMES.flatMap((name): Array<[string, Handler]> => {
      const path = `/api/v1/assistants/${id}/memory/${name}`;
      const read = (): MemoryDocument | undefined =>
        readDocuments().find((each) => each.name === name);
      const missingDocument = {
        status: 404,
        body: buildErrorBody("not_found", `no memory document named "${name}"`),
      };
      return [
        [
          `GET ${path}`,
          () => {
            const current = read();
            return current === undefined ? missingDocument : { body: current };
          },
        ],
        [
          `PUT ${path}`,
          (call) => {
            const input = call.body as MemoryWriteInput;
            const current = read();
            const version = current?.version ?? 0;
            if (input.expectedVersion !== undefined && input.expectedVersion !== version) {
              return {
                status: 409,
                body: buildErrorBody(
                  "conflict",
                  `${name} is at version ${String(version)}, not ${String(input.expectedVersion)}; read it again`,
                ),
              };
            }
            const size = countCharacters(input.body);
            const cap = chooseMemoryCap(name);
            if (size > cap) {
              return {
                status: 422,
                body: {
                  error: {
                    code: "cap_exceeded",
                    message: `${name} is ${String(size)} chars; cap is ${String(cap)}`,
                    details: { size, cap },
                  },
                },
              };
            }
            if (
              current !== undefined &&
              input.confirmShrink !== true &&
              requiresShrinkConfirmation(current.size, size)
            ) {
              return {
                status: 422,
                body: {
                  error: {
                    code: "shrink_rejected",
                    message: `${name} would shrink from ${String(current.size)} to ${String(size)} chars; send confirmShrink: true to write it anyway`,
                    details: { previousSize: current.size, size },
                  },
                },
              };
            }
            const saved = buildMemoryDocument(
              name,
              input.gist ?? current?.gist ?? "",
              input.body,
              version + 1,
            );
            memory.set(
              id,
              current === undefined
                ? [...readDocuments(), saved]
                : readDocuments().map((each) => (each.name === name ? saved : each)),
            );
            return { body: saved };
          },
        ],
        [
          `DELETE ${path}`,
          () => {
            memory.set(
              id,
              readDocuments().filter((each) => each.name !== name),
            );
            return { body: {} };
          },
        ],
      ];
    });
    return [
      [
        `GET /api/v1/assistants/${id}/memory`,
        () => ({
          body: readDocuments().map(({ name, gist, size }) => ({ name, gist, size })),
        }),
      ],
      ...documentRoutes,
    ];
  });
  return {
    "GET /api/v1/setup": { body: { complete: true } },
    "GET /api/v1/settings": {
      body: {
        controller: {},
        user: {
          "onboarding.completedSteps": ["timezone", "assistant"],
          timezone: "Europe/Amsterdam",
        },
      },
    },
    "GET /api/v1/provider-accounts": { body: ACCOUNTS },
    "GET /api/v1/profiles": { body: { items: PROFILES } },
    "GET /api/v1/runners": { body: { items: [] } },
    "GET /api/v1/assistants": () => ({ body: { items: list } }),
    "POST /api/v1/assistants": (call) => {
      const created = { ...CREATED, ...(call.body as Partial<Assistant>) };
      list = [...list, created];
      return { body: created };
    },
    ...Object.fromEntries(perAssistant),
    ...Object.fromEntries(perMemory),
    ...extra,
  };
};

const openScreen = async (
  initial: readonly Assistant[],
  extra: Readonly<Record<string, Handler>> = {},
) => {
  const api = stubApi(buildController(initial, extra));
  const app = await renderApp({ path: "/settings/assistants", api: api.fetch, token: "held" });
  return { ...app, api };
};

/**
 * Opens the screen on a controller whose routes `wrap` rewrites. `wrap`
 * receives the routes of `buildController(initial)`, and `answer` calls one
 * of them, so a test can hold a write, or fail a read after a write.
 */
const openScreenAround = async (
  initial: readonly Assistant[],
  wrap: (
    routes: Readonly<Record<string, Handler>>,
    answer: (route: string, call: Call) => Answer | Promise<Answer>,
  ) => Readonly<Record<string, Handler>>,
) => {
  const routes = buildController(initial);
  const answer = (route: string, call: Call): Answer | Promise<Answer> => {
    const handler = routes[route];
    if (handler === undefined) throw new Error(`no route ${route}`);
    return typeof handler === "function" ? handler(call) : handler;
  };
  const api = stubApi({ ...routes, ...wrap(routes, answer) });
  const app = await renderApp({ path: "/settings/assistants", api: api.fetch, token: "held" });
  return { ...app, api };
};

/** Returns a promise and the function that resolves it, for holding a stub's answer. */
const holdAnswer = (): { readonly held: Promise<void>; readonly release: () => void } => {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
};

/** Returns the writes the screen sent to the assistants endpoints, memory included, in order. */
const listWrites = (api: { readonly calls: readonly Call[] }): readonly Call[] =>
  api.calls.filter((call) => call.method !== "GET" && call.path.startsWith("/api/v1/assistants"));

/**
 * Finds the list row of the assistant named `name`. A row is a button whose
 * accessible name starts with the assistant's name, so a row may carry more
 * text after it.
 */
const findAssistantRow = (name: string): Promise<HTMLElement> =>
  screen.findByRole("button", { name: new RegExp(`^${name}(\\s|$)`) });

const queryAssistantRow = (name: string): HTMLElement | null =>
  screen.queryByRole("button", { name: new RegExp(`^${name}(\\s|$)`) });

/** Selects the assistant named `name` in the list and waits for its form. */
const selectAssistant = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(await findAssistantRow(name));
  await waitFor(() => {
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe(name);
  });
};

/** Returns the label of the checked segment in the segmented control named `name`. */
const readCheckedSegment = (name: string): string | null | undefined =>
  within(screen.getByRole("radiogroup", { name }))
    .getAllByRole("radio")
    .find((item) => item.getAttribute("aria-checked") === "true")?.textContent;

const EMPTY_HEADLINE = "No assistants.";
const EMPTY_LEAD =
  "An assistant is a conversation with memory, bound to the channels you give it. Its memory, heartbeat and reply style are edited here.";

describe("Settings > Assistants: the list and the form", () => {
  it("lists every assistant by name", async () => {
    await openScreen([ADA, BOB]);

    expect(await findAssistantRow("Ada")).toBeDefined();
    expect(await findAssistantRow("Bob")).toBeDefined();
  });

  it("shows the selected assistant's fields in the form", async () => {
    const user = userEvent.setup();
    await openScreen([ADA, BOB]);

    await selectAssistant(user, "Bob");

    const persona = screen.getByLabelText<HTMLTextAreaElement>("Persona");
    expect(persona.tagName).toBe("TEXTAREA");
    expect(persona.value).toBe(BOB.systemPrompt);

    const account = screen.getByLabelText<HTMLSelectElement>("Account");
    expect([...account.options].map((option) => option.textContent)).toEqual([
      "Anthropic",
      "Anthropic · work",
    ]);
    expect(account.value).toBe(ACCOUNT_WORK.id);

    const profile = screen.getByLabelText<HTMLSelectElement>("Permission profile");
    expect([...profile.options].map((option) => option.textContent)).toEqual(
      PROFILES.map((each) => each.name),
    );
    expect(profile.value).toBe(PROFILE_UNRESTRICTED.id);

    const access = screen.getByRole("radiogroup", { name: "Access mode" });
    expect(
      within(access)
        .getAllByRole("radio")
        .map((item) => item.textContent),
    ).toEqual(["Approval required", "Auto-accept edits", "Auto", "Full access"]);
    expect(readCheckedSegment("Access mode")).toBe("Auto");

    const reply = screen.getByRole("radiogroup", { name: "Reply" });
    expect(
      within(reply)
        .getAllByRole("radio")
        .map((item) => item.textContent),
    ).toEqual(["Turn end", "Segments"]);
    expect(readCheckedSegment("Reply")).toBe("Segments");
  });

  it("says when each kind of change reaches the assistant's session", async () => {
    const user = userEvent.setup();
    await openScreen([ADA, BOB]);

    await selectAssistant(user, "Bob");

    expect(
      screen.getByText(
        "Reply applies at once. Access mode and permission profile apply when Bob's session next resumes, " +
          "after it is unloaded for being idle or is stopped. The other fields apply only to a new session.",
      ),
    ).toBeDefined();
  });

  it("saves only the changed name and reply", async () => {
    const user = userEvent.setup();
    const { api } = await openScreen([ADA, BOB]);
    await selectAssistant(user, "Ada");

    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Ada Lovelace");
    await user.click(
      within(screen.getByRole("radiogroup", { name: "Reply" })).getByRole("radio", {
        name: "Segments",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(listWrites(api)).toHaveLength(1);
    });
    const [write] = listWrites(api);
    expect(`${write?.method} ${write?.path}`).toBe(`PATCH /api/v1/assistants/${ADA.id}`);
    expect(write?.body).toEqual({ name: "Ada Lovelace", reply: "segments" });
  });

  it("saves only the changed persona, account, permission profile and access mode", async () => {
    const user = userEvent.setup();
    const { api } = await openScreen([ADA, BOB]);
    await selectAssistant(user, "Ada");

    const persona = screen.getByLabelText("Persona");
    await user.clear(persona);
    await user.type(persona, "You are Ada.{Enter}Answer in Dutch.");
    await user.selectOptions(screen.getByLabelText("Account"), "Anthropic · work");
    await user.selectOptions(
      screen.getByLabelText("Permission profile"),
      PROFILE_UNRESTRICTED.name,
    );
    await user.click(
      within(screen.getByRole("radiogroup", { name: "Access mode" })).getByRole("radio", {
        name: "Full access",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(listWrites(api)).toHaveLength(1);
    });
    const [write] = listWrites(api);
    expect(`${write?.method} ${write?.path}`).toBe(`PATCH /api/v1/assistants/${ADA.id}`);
    expect(write?.body).toEqual({
      systemPrompt: "You are Ada.\nAnswer in Dutch.",
      providerAccountId: ACCOUNT_WORK.id,
      permissionProfileId: PROFILE_UNRESTRICTED.id,
      accessMode: "full-access",
    });
  });

  it("shows a refused save's error and keeps the edits", async () => {
    const user = userEvent.setup();
    const { api } = await openScreen([ADA, BOB], {
      [`PATCH /api/v1/assistants/${ADA.id}`]: {
        status: 500,
        body: buildErrorBody("internal", "the database is locked"),
      },
    });
    await selectAssistant(user, "Ada");

    const name = screen.getByLabelText<HTMLInputElement>("Name");
    await user.clear(name);
    await user.type(name, "Ada Lovelace");
    await user.click(
      within(screen.getByRole("radiogroup", { name: "Reply" })).getByRole("radio", {
        name: "Segments",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toBe("the database is locked");
    expect(listWrites(api)).toHaveLength(1);
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Ada Lovelace");
    expect(readCheckedSegment("Reply")).toBe("Segments");
  });

  it("shows the empty state's copy verbatim when there is no assistant", async () => {
    await openScreen([]);

    expect(await screen.findByText(EMPTY_HEADLINE)).toBeDefined();
    expect(screen.getByText(EMPTY_LEAD)).toBeDefined();
    expect(screen.queryByLabelText("Name")).toBeNull();
  });
});

describe("Settings > Assistants: deleting an assistant", () => {
  it("asks before deleting, then deletes the assistant and drops it from the list", async () => {
    const user = userEvent.setup();
    const { api } = await openScreen([ADA, BOB]);
    await selectAssistant(user, "Ada");

    await user.click(screen.getByRole("button", { name: "Delete assistant" }));

    await waitFor(() => {
      expect(readPageText()).toContain(QUESTION_ADA);
    });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Delete" });
    expectInDocumentOrder([cancel, confirm]);
    expect(listWrites(api)).toEqual([]);

    await user.click(confirm);

    await waitFor(() => {
      expect(queryAssistantRow("Ada")).toBeNull();
    });
    expect(listWrites(api).map((call) => `${call.method} ${call.path}`)).toEqual([
      `DELETE /api/v1/assistants/${ADA.id}`,
    ]);
    expect(await findAssistantRow("Bob")).toBeDefined();
  });

  it("sends nothing when the question is cancelled", async () => {
    const user = userEvent.setup();
    const { api } = await openScreen([ADA, BOB]);
    await selectAssistant(user, "Ada");

    await user.click(screen.getByRole("button", { name: "Delete assistant" }));
    await waitFor(() => {
      expect(readPageText()).toContain(QUESTION_ADA);
    });
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(readPageText()).not.toContain(QUESTION_ADA);
    });
    expect(listWrites(api)).toEqual([]);
    expect(await findAssistantRow("Ada")).toBeDefined();
  });

  it("moves focus to Cancel when it asks, and back to Delete assistant when cancelled", async () => {
    const user = userEvent.setup();
    await openScreen([ADA, BOB]);
    await selectAssistant(user, "Ada");

    const ask = screen.getByRole("button", { name: "Delete assistant" });
    await user.click(ask);
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);

    await user.click(cancel);

    await waitFor(() => {
      expect(document.activeElement).toBe(ask);
    });
  });
});

describe("Settings > Assistants: New assistant", () => {
  it("offers New assistant when there are assistants", async () => {
    await openScreen([ADA]);

    await findAssistantRow("Ada");
    expect(screen.getByRole("button", { name: "New assistant" })).toBeDefined();
  });

  it("offers New assistant in the empty state, below the copy", async () => {
    await openScreen([]);

    const lead = await screen.findByText(EMPTY_LEAD);
    const button = screen.getByRole("button", { name: "New assistant" });
    expectInDocumentOrder([screen.getByText(EMPTY_HEADLINE), lead, button]);
  });

  it("creates an assistant named Hercule, adds it to the list and selects it", async () => {
    const user = userEvent.setup();
    const { api } = await openScreen([ADA]);
    await selectAssistant(user, "Ada");

    await user.click(screen.getByRole("button", { name: "New assistant" }));

    expect(await findAssistantRow("Hercule")).toBeDefined();
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Hercule");
    });
    expect(screen.getByLabelText<HTMLTextAreaElement>("Persona").value).toBe(CREATED.systemPrompt);
    expect(await findAssistantRow("Ada")).toBeDefined();
    expect(listWrites(api).map((call) => [`${call.method} ${call.path}`, call.body])).toEqual([
      ["POST /api/v1/assistants", { name: "Hercule" }],
    ]);
  });

  it("creates an assistant from the empty state and shows its form", async () => {
    const user = userEvent.setup();
    const { api } = await openScreen([]);

    await user.click(await screen.findByRole("button", { name: "New assistant" }));

    expect(await findAssistantRow("Hercule")).toBeDefined();
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Hercule");
    });
    expect(screen.queryByText(EMPTY_HEADLINE)).toBeNull();
    expect(listWrites(api).map((call) => [`${call.method} ${call.path}`, call.body])).toEqual([
      ["POST /api/v1/assistants", { name: "Hercule" }],
    ]);
  });

  it("shows a refused create's error and adds nothing", async () => {
    const user = userEvent.setup();
    const { api } = await openScreen([ADA], {
      "POST /api/v1/assistants": {
        status: 500,
        body: buildErrorBody("internal", "the database is locked"),
      },
    });
    await findAssistantRow("Ada");

    await user.click(screen.getByRole("button", { name: "New assistant" }));

    expect((await screen.findByRole("alert")).textContent).toBe("the database is locked");
    expect(listWrites(api)).toHaveLength(1);
    expect(queryAssistantRow("Hercule")).toBeNull();
    expect(await findAssistantRow("Ada")).toBeDefined();
  });
});

// The tests below were added in review round 1 of #92 slice 4.

const ADA_PATCH = `PATCH /api/v1/assistants/${ADA.id}`;
const ADA_DELETE = `DELETE /api/v1/assistants/${ADA.id}`;

/** Replaces the text of the field labelled `label` with `text`. */
const retype = async (user: ReturnType<typeof userEvent.setup>, label: string, text: string) => {
  const field = screen.getByLabelText(label);
  await user.clear(field);
  await user.type(field, text);
};

describe("Settings > Assistants: saving", () => {
  it("shows the stored values after a save, with Save disabled and Saved. shown", async () => {
    const user = userEvent.setup();
    await openScreen([ADA, BOB]);
    await selectAssistant(user, "Ada");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveProperty("disabled", true);

    await retype(user, "Name", "Ada Lovelace");
    expect(save).toHaveProperty("disabled", false);
    await user.click(save);

    expect(await screen.findByText("Saved.")).toBeDefined();
    expect(await findAssistantRow("Ada Lovelace")).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Ada Lovelace");
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  });

  it("disables Save while the save runs", async () => {
    const user = userEvent.setup();
    const { held, release } = holdAnswer();
    await openScreenAround([ADA, BOB], (_routes, answer) => ({
      [ADA_PATCH]: async (call) => {
        await held;
        return answer(ADA_PATCH, call);
      },
    }));
    await selectAssistant(user, "Ada");

    await retype(user, "Name", "Ada Lovelace");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    });
    release();
    expect(await screen.findByText("Saved.")).toBeDefined();
  });

  it("keeps text typed while the save runs, and does not say Saved.", async () => {
    const user = userEvent.setup();
    const { held, release } = holdAnswer();
    const { api } = await openScreenAround([ADA, BOB], (_routes, answer) => ({
      [ADA_PATCH]: async (call) => {
        await held;
        return answer(ADA_PATCH, call);
      },
    }));
    await selectAssistant(user, "Ada");

    await retype(user, "Name", "Ada L");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.type(screen.getByLabelText("Name"), "ovelace");
    release();

    await waitFor(() => {
      expect(queryAssistantRow("Ada L")).not.toBeNull();
    });
    expect(listWrites(api).map((call) => call.body)).toEqual([{ name: "Ada L" }]);
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Ada Lovelace");
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false);
    expect(screen.queryByText("Saved.")).toBeNull();
  });

  it("clears Saved. as soon as there is a new change", async () => {
    const user = userEvent.setup();
    await openScreen([ADA, BOB]);
    await selectAssistant(user, "Ada");

    await retype(user, "Name", "Ada Lovelace");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved.")).toBeDefined();

    await user.type(screen.getByLabelText("Name"), "!");

    expect(screen.queryByText("Saved.")).toBeNull();
  });

  it("shows the saved values even when the list cannot be read again after the save", async () => {
    const user = userEvent.setup();
    let saved = false;
    await openScreenAround([ADA, BOB], (_routes, answer) => ({
      [ADA_PATCH]: (call) => {
        saved = true;
        return answer(ADA_PATCH, call);
      },
      "GET /api/v1/assistants": (call) =>
        saved
          ? { status: 500, body: buildErrorBody("internal", "the database is locked") }
          : answer("GET /api/v1/assistants", call),
    }));
    await selectAssistant(user, "Ada");

    await retype(user, "Name", "Ada Lovelace");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await findAssistantRow("Ada Lovelace")).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Ada Lovelace");
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  });

  it("shows another writer's change to a field the user has not edited, and keeps the user's edit", async () => {
    const user = userEvent.setup();
    let persona = ADA.systemPrompt;
    const { live } = await openScreenAround([ADA, BOB], () => ({
      "GET /api/v1/assistants": () => ({
        body: { items: [{ ...ADA, systemPrompt: persona }, BOB] },
      }),
    }));
    await selectAssistant(user, "Ada");
    await retype(user, "Name", "Ada Lovelace");
    await waitFor(() => {
      expect(live.topics()).toContain("assistant");
    });

    persona = "You are Ada. Answer in Dutch.";
    live.push("assistant", { _tag: "invalidate", ids: [ADA.id], kind: "updated" });

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLTextAreaElement>("Persona").value).toBe(persona);
    });
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Ada Lovelace");
  });

  it("forgets a field typed back to its stored value, so another writer's later change to it shows", async () => {
    const user = userEvent.setup();
    let persona = ADA.systemPrompt;
    const { live } = await openScreenAround([ADA, BOB], () => ({
      "GET /api/v1/assistants": () => ({
        body: { items: [{ ...ADA, systemPrompt: persona }, BOB] },
      }),
    }));
    await selectAssistant(user, "Ada");
    await retype(user, "Persona", "You are Ada.");
    await retype(user, "Persona", ADA.systemPrompt);
    await waitFor(() => {
      expect(live.topics()).toContain("assistant");
    });

    persona = "You are Ada. Answer in Dutch.";
    live.push("assistant", { _tag: "invalidate", ids: [ADA.id], kind: "updated" });

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLTextAreaElement>("Persona").value).toBe(persona);
    });
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  });

  it("shows a stored account and profile that are no longer listed as not found, and never sends them", async () => {
    const user = userEvent.setup();
    const orphan = {
      ...ADA,
      providerAccountId: "01a06d02-1000-7000-8000-0000000000ff",
      permissionProfileId: "01a06d02-3000-7000-8000-0000000000ee",
    };
    const { api } = await openScreen([orphan, BOB]);
    await selectAssistant(user, "Ada");

    const account = screen.getByLabelText<HTMLSelectElement>("Account");
    expect(account.value).toBe(orphan.providerAccountId);
    expect(account.selectedOptions[0]?.textContent).toBe("000000ff (not found)");
    const profile = screen.getByLabelText<HTMLSelectElement>("Permission profile");
    expect(profile.value).toBe(orphan.permissionProfileId);
    expect(profile.selectedOptions[0]?.textContent).toBe("000000ee (not found)");

    await retype(user, "Name", "Ada Lovelace");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(listWrites(api)).toHaveLength(1);
    });
    expect(listWrites(api)[0]?.body).toEqual({ name: "Ada Lovelace" });
  });
});

describe("Settings > Assistants: leaving unsaved edits", () => {
  it("asks before switching to another assistant, and keeps the edits on Cancel", async () => {
    const user = userEvent.setup();
    await openScreen([ADA, BOB]);
    await selectAssistant(user, "Ada");
    await retype(user, "Name", "Ada Lovelace");

    await user.click(await findAssistantRow("Bob"));

    await waitFor(() => {
      expect(readPageText()).toContain("Discard changes to Ada?");
    });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expectInDocumentOrder([cancel, screen.getByRole("button", { name: "Discard" })]);
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Ada Lovelace");

    await user.click(cancel);

    expect(readPageText()).not.toContain("Discard changes to Ada?");
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Ada Lovelace");
  });

  it("switches and drops the edits on Discard", async () => {
    const user = userEvent.setup();
    const { api } = await openScreen([ADA, BOB]);
    await selectAssistant(user, "Ada");
    await retype(user, "Name", "Ada Lovelace");

    await user.click(await findAssistantRow("Bob"));
    await user.click(await screen.findByRole("button", { name: "Discard" }));

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Bob");
    });
    await user.click(await findAssistantRow("Ada"));
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Ada");
    });
    expect(listWrites(api)).toEqual([]);
  });

  it("asks before New assistant, and creates it on Discard", async () => {
    const user = userEvent.setup();
    const { api } = await openScreen([ADA]);
    await selectAssistant(user, "Ada");
    await retype(user, "Name", "Ada Lovelace");

    await user.click(screen.getByRole("button", { name: "New assistant" }));

    await waitFor(() => {
      expect(readPageText()).toContain("Discard changes to Ada?");
    });
    expect(listWrites(api)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Discard" }));

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Hercule");
    });
    expect(listWrites(api).map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/v1/assistants",
    ]);
  });

  it("moves focus to the newly selected row on Discard", async () => {
    const user = userEvent.setup();
    await openScreen([ADA, BOB]);
    await selectAssistant(user, "Ada");
    await retype(user, "Name", "Ada Lovelace");

    await user.click(await findAssistantRow("Bob"));
    await user.click(await screen.findByRole("button", { name: "Discard" }));

    await waitFor(() => {
      expect(document.activeElement).toBe(queryAssistantRow("Bob"));
    });
  });

  it("moves focus to the new assistant's row once it is created", async () => {
    const user = userEvent.setup();
    await openScreen([ADA]);

    await user.click(await screen.findByRole("button", { name: "New assistant" }));

    await waitFor(() => {
      expect(document.activeElement).toBe(queryAssistantRow("Hercule"));
    });
  });

  it("keeps Cancel and Discard disabled while a save runs", async () => {
    const user = userEvent.setup();
    const { held, release } = holdAnswer();
    await openScreenAround([ADA, BOB], (_routes, answer) => ({
      [ADA_PATCH]: async (call) => {
        await held;
        return answer(ADA_PATCH, call);
      },
    }));
    await selectAssistant(user, "Ada");
    await retype(user, "Name", "Ada Lovelace");
    await user.click(await findAssistantRow("Bob"));
    await screen.findByRole("button", { name: "Discard" });

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Discard" })).toHaveProperty("disabled", true);
    });
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);

    release();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Discard" })).toHaveProperty("disabled", false);
    });
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Ada Lovelace");
    expect(await findAssistantRow("Ada Lovelace")).toBeDefined();
  });

  it("switches without asking when nothing is edited", async () => {
    const user = userEvent.setup();
    await openScreen([ADA, BOB]);
    await selectAssistant(user, "Ada");

    await selectAssistant(user, "Bob");

    expect(readPageText()).not.toContain("Discard changes");
  });

  it("keeps the list and New assistant disabled while a save runs", async () => {
    const user = userEvent.setup();
    const { held, release } = holdAnswer();
    await openScreenAround([ADA, BOB], (_routes, answer) => ({
      [ADA_PATCH]: async (call) => {
        await held;
        return answer(ADA_PATCH, call);
      },
    }));
    await selectAssistant(user, "Ada");
    await retype(user, "Name", "Ada Lovelace");

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(queryAssistantRow("Bob")).toHaveProperty("disabled", true);
    });
    expect(screen.getByRole("button", { name: "New assistant" })).toHaveProperty("disabled", true);

    release();

    await waitFor(() => {
      expect(queryAssistantRow("Bob")).toHaveProperty("disabled", false);
    });
    expect(screen.getByRole("button", { name: "New assistant" })).toHaveProperty("disabled", false);
  });
});

describe("Settings > Assistants: after a delete", () => {
  it("says Deleting… while the delete runs", async () => {
    const user = userEvent.setup();
    const { held, release } = holdAnswer();
    await openScreenAround([ADA, BOB], (_routes, answer) => ({
      [ADA_DELETE]: async (call) => {
        await held;
        return answer(ADA_DELETE, call);
      },
    }));
    await selectAssistant(user, "Ada");

    await user.click(screen.getByRole("button", { name: "Delete assistant" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    expect(await screen.findByRole("button", { name: "Deleting…" })).toHaveProperty(
      "disabled",
      true,
    );
    release();
    await waitFor(() => {
      expect(queryAssistantRow("Ada")).toBeNull();
    });
  });

  it("keeps the list and New assistant disabled while the delete runs", async () => {
    const user = userEvent.setup();
    const { held, release } = holdAnswer();
    await openScreenAround([ADA, BOB], (_routes, answer) => ({
      [ADA_DELETE]: async (call) => {
        await held;
        return answer(ADA_DELETE, call);
      },
    }));
    await selectAssistant(user, "Ada");

    await user.click(screen.getByRole("button", { name: "Delete assistant" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(queryAssistantRow("Bob")).toHaveProperty("disabled", true);
    });
    expect(screen.getByRole("button", { name: "New assistant" })).toHaveProperty("disabled", true);

    release();

    await waitFor(() => {
      expect(queryAssistantRow("Ada")).toBeNull();
    });
    expect(queryAssistantRow("Bob")).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "New assistant" })).toHaveProperty("disabled", false);
  });

  it("selects the first remaining assistant and moves focus to its row", async () => {
    const user = userEvent.setup();
    await openScreen([ADA, BOB]);
    await selectAssistant(user, "Ada");

    await user.click(screen.getByRole("button", { name: "Delete assistant" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Bob");
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(queryAssistantRow("Bob"));
    });
  });

  it("moves focus to New assistant when the last assistant is deleted", async () => {
    const user = userEvent.setup();
    await openScreen([ADA]);
    await selectAssistant(user, "Ada");

    await user.click(screen.getByRole("button", { name: "Delete assistant" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    expect(await screen.findByText(EMPTY_HEADLINE)).toBeDefined();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "New assistant" }));
    });
  });

  it("shows a refused delete's error and keeps the assistant", async () => {
    const user = userEvent.setup();
    await openScreen([ADA, BOB], {
      [ADA_DELETE]: {
        status: 404,
        body: buildErrorBody("not_found", "no assistant has that id"),
      },
    });
    await selectAssistant(user, "Ada");

    await user.click(screen.getByRole("button", { name: "Delete assistant" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    expect((await screen.findByRole("alert")).textContent).toBe("no assistant has that id");
    expect(await findAssistantRow("Ada")).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Ada");
    expect(screen.getByRole("button", { name: "Delete assistant" })).toHaveProperty(
      "disabled",
      false,
    );
  });
});

/** Returns the writes the screen sent to one assistant's memory, in order. */
const listMemoryWrites = (
  api: { readonly calls: readonly Call[] },
  assistantId: string,
): readonly Call[] =>
  api.calls.filter(
    (call) =>
      call.method !== "GET" && call.path.startsWith(`/api/v1/assistants/${assistantId}/memory`),
  );

/** Finds the row of the topic named `name`: the button around the text of its name. */
const findTopicRow = async (name: string): Promise<HTMLElement> => {
  const label = await screen.findByText(name, { selector: "ul button > span" });
  const row = label.closest("button");
  if (row === null) throw new Error(`no row for the topic ${name}`);
  return row;
};

/** Opens the topic named `name` and waits for its text to load. */
const openTopic = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(await findTopicRow(name));
  return screen.findByLabelText<HTMLTextAreaElement>("Text");
};

describe("Settings > Assistants: memory", () => {
  it("shows the core note with its usage, and every topic with its gist and size", async () => {
    await openScreen([ADA, BOB]);

    const core = await screen.findByLabelText<HTMLTextAreaElement>("Core note");
    expect(core.value).toBe("Rogier lives in Amsterdam. Prefers short answers.");
    expect(screen.getByText("49 of 4,000")).toBeDefined();
    expect(
      screen.getByRole("meter", { name: "Core note used" }).getAttribute("aria-valuenow"),
    ).toBe("49");

    const decisions = await findTopicRow("decisions");
    expect(decisions.textContent).toBe(
      "decisionsWhat we decided about the build, and why each choice was made over the others28",
    );
    expect((await findTopicRow("people")).textContent).toBe("people1.4k");
    expect(screen.getByText("2 of 24 topics · up to 12,000 characters each")).toBeDefined();
    expect(queryTopicNames()).toEqual(["decisions", "people"]);
  });

  it("keeps a long gist on one line and puts the whole gist in its tooltip", async () => {
    await openScreen([ADA]);

    const gist = within(await findTopicRow("decisions")).getByText(
      "What we decided about the build, and why each choice was made over the others",
    );
    expect(gist.className).toContain("truncate");
    expect(gist.getAttribute("title")).toBe(gist.textContent);
  });

  it("says when an assistant has no topics", async () => {
    const user = userEvent.setup();
    await openScreen([ADA, BOB]);
    await selectAssistant(user, "Bob");

    expect(await screen.findByText("No topics yet.")).toBeDefined();
    expect(screen.getByText("0 of 24 topics · up to 12,000 characters each")).toBeDefined();
  });

  it("shows a memory read's error in the memory section and keeps the form", async () => {
    await openScreen([ADA], {
      [`GET /api/v1/assistants/${ADA.id}/memory`]: {
        status: 500,
        body: buildErrorBody("internal", "the database is locked"),
      },
    });

    expect((await screen.findByRole("alert")).textContent).toBe("the database is locked");
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Ada");
  });

  it("saves the edited core note, counting as the user types", async () => {
    const user = userEvent.setup();
    const { api } = await openScreen([ADA]);

    const core = await screen.findByLabelText("Core note");
    await user.type(core, " Has a cat.");
    expect(screen.getByText("60 of 4,000")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Save core note" }));

    expect(await screen.findByText("Saved.")).toBeDefined();
    const writes = listMemoryWrites(api, ADA.id);
    expect(writes.map((call) => `${call.method} ${call.path}`)).toEqual([
      `PUT /api/v1/assistants/${ADA.id}/memory/core`,
    ]);
    // `core` has no gist, so none is sent.
    expect(writes[0]?.body).toEqual({
      body: "Rogier lives in Amsterdam. Prefers short answers. Has a cat.",
      expectedVersion: 1,
    });
    expect(screen.getByRole("button", { name: "Save core note" })).toHaveProperty("disabled", true);
  });

  it("saves a topic's edited gist with its text, and shows the new gist in the list", async () => {
    const user = userEvent.setup();
    const { api } = await openScreen([ADA]);

    await openTopic(user, "decisions");
    const gist = screen.getByLabelText("Gist");
    await user.clear(gist);
    await user.type(gist, "build decisions");
    await user.click(screen.getByRole("button", { name: "Save topic decisions" }));

    await waitFor(async () => {
      expect((await findTopicRow("decisions")).textContent).toBe("decisionsbuild decisions28");
    });
    expect(listMemoryWrites(api, ADA.id).map((call) => call.body)).toEqual([
      { body: "Use SQLite.\nShip one binary.", gist: "build decisions", expectedVersion: 1 },
    ]);
  });

  it("adds a topic with its name, gist and text, and opens it", async () => {
    const user = userEvent.setup();
    const { api } = await openScreen([ADA]);
    await findTopicRow("decisions");

    await user.click(screen.getByRole("button", { name: "New topic" }));
    await user.type(screen.getByLabelText("Topic name"), "travel");
    await user.type(screen.getByLabelText("Gist"), "trips and bookings");
    await user.type(screen.getByLabelText("Text"), "Flies KLM.");
    await user.click(screen.getByRole("button", { name: "Save new topic" }));

    expect((await findTopicRow("travel")).textContent).toBe("traveltrips and bookings10");
    expect(
      listMemoryWrites(api, ADA.id).map((call) => [`${call.method} ${call.path}`, call.body]),
    ).toEqual([
      [
        `PUT /api/v1/assistants/${ADA.id}/memory/travel`,
        // Version 0: the topic must not exist yet.
        { body: "Flies KLM.", gist: "trips and bookings", expectedVersion: 0 },
      ],
    ]);
    expect(screen.getByRole("button", { name: "Save topic travel" })).toBeDefined();
    expect(screen.getByText("3 of 24 topics · up to 12,000 characters each")).toBeDefined();
  });

  it("refuses a new topic named like an existing one, before any write", async () => {
    const user = userEvent.setup();
    const { api } = await openScreen([ADA]);
    await findTopicRow("decisions");

    await user.click(screen.getByRole("button", { name: "New topic" }));
    await user.type(screen.getByLabelText("Topic name"), "decisions");

    expect((await screen.findByRole("alert")).textContent).toBe(
      'A topic named "decisions" already exists; open it to edit it.',
    );
    expect(screen.getByRole("button", { name: "Save new topic" })).toHaveProperty("disabled", true);
    expect(listMemoryWrites(api, ADA.id)).toEqual([]);
  });

  it("shows the contract's message for a topic name with a slash, and sends nothing", async () => {
    const user = userEvent.setup();
    const { api } = await openScreen([ADA]);
    await findTopicRow("decisions");

    await user.click(screen.getByRole("button", { name: "New topic" }));
    await user.type(screen.getByLabelText("Topic name"), "a/b");
    await user.click(screen.getByRole("button", { name: "Save new topic" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "a memory name cannot contain a slash",
    );
    expect(listMemoryWrites(api, ADA.id)).toEqual([]);
  });

  it("deletes a topic after a question, and drops it from the list", async () => {
    const user = userEvent.setup();
    const { api } = await openScreen([ADA]);

    await openTopic(user, "decisions");
    await user.click(screen.getByRole("button", { name: "Delete topic" }));
    expect(
      screen.getByText("Delete the topic decisions? Its gist and text are deleted."),
    ).toBeDefined();
    expect(listMemoryWrites(api, ADA.id)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(queryTopicNames()).toEqual(["people"]);
    });
    expect(listMemoryWrites(api, ADA.id).map((call) => `${call.method} ${call.path}`)).toEqual([
      `DELETE /api/v1/assistants/${ADA.id}/memory/decisions`,
    ]);
    expect(screen.queryByLabelText("Text")).toBeNull();
  });

  it("shows the controller's cap_exceeded message as it is, and keeps the text", async () => {
    const user = userEvent.setup();
    await openScreen([ADA]);

    const core = await screen.findByLabelText<HTMLTextAreaElement>("Core note");
    await user.clear(core);
    await user.click(core);
    await user.paste("x".repeat(4001));
    expect(screen.getByText("4,001 of 4,000")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Save core note" }));

    expect((await screen.findByRole("alert")).textContent).toBe("core is 4001 chars; cap is 4000");
    expect(core.value).toHaveLength(4001);
  });

  it("asks before a write that shrinks a large topic, and Save anyway confirms the shrink", async () => {
    const user = userEvent.setup();
    const { api } = await openScreen([ADA]);

    const body = await openTopic(user, "people");
    await user.clear(body);
    await user.type(body, "Ines left.");
    await user.click(screen.getByRole("button", { name: "Save topic people" }));

    // The question is built from the sizes in the error, not the
    // controller's message, which is written for agents and the CLI.
    const question =
      "This cuts the document from 1,400 to 10 characters. What it cuts cannot be brought back.";
    expect(await screen.findByText(question)).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save anyway" }));

    expect(await screen.findByText("Saved.")).toBeDefined();
    expect(listMemoryWrites(api, ADA.id).map((call) => call.body)).toEqual([
      { body: "Ines left.", expectedVersion: 1 },
      { body: "Ines left.", expectedVersion: 1, confirmShrink: true },
    ]);
    expect(screen.queryByText(question)).toBeNull();
    expect((await findTopicRow("people")).textContent).toBe("people10");
  });

  it("writes nothing when the shrink question is cancelled, and keeps the text", async () => {
    const user = userEvent.setup();
    const { api } = await openScreen([ADA]);

    const body = await openTopic(user, "people");
    await user.clear(body);
    await user.type(body, "Ines left.");
    await user.click(screen.getByRole("button", { name: "Save topic people" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("button", { name: "Save anyway" })).toBeNull();
    expect(listMemoryWrites(api, ADA.id)).toHaveLength(1);
    expect(screen.getByLabelText<HTMLTextAreaElement>("Text").value).toBe("Ines left.");
  });

  it("refuses a save over text the assistant wrote since, keeps the user's text, and Save anyway writes it", async () => {
    const user = userEvent.setup();
    const route = `PUT /api/v1/assistants/${ADA.id}/memory/decisions`;
    const assistantText = "Use SQLite.\nShip one binary.\nTest on Node.";
    let assistantWrote = false;
    const { api } = await openScreenAround([ADA], (_routes, answer) => ({
      [route]: async (call) => {
        // The assistant writes the topic just before the user's first save.
        if (!assistantWrote) {
          assistantWrote = true;
          await answer(route, { ...call, body: { body: assistantText } });
        }
        return answer(route, call);
      },
    }));

    const body = await openTopic(user, "decisions");
    await user.type(body, " Test on Bun.");
    await user.click(screen.getByRole("button", { name: "Save topic decisions" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "decisions is at version 2, not 1; read it again",
    );
    expect(body.value).toBe("Use SQLite.\nShip one binary. Test on Bun.");
    await user.click(await screen.findByRole("button", { name: "Save anyway" }));

    expect(await screen.findByText("Saved.")).toBeDefined();
    // The assistant's write goes straight to the stub, so only the user's are listed.
    expect(listMemoryWrites(api, ADA.id).map((call) => call.body)).toEqual([
      { body: "Use SQLite.\nShip one binary. Test on Bun.", expectedVersion: 1 },
      { body: "Use SQLite.\nShip one binary. Test on Bun.", expectedVersion: 2 },
    ]);
    expect(body.value).toBe("Use SQLite.\nShip one binary. Test on Bun.");
  });

  it("keeps the old text typed back while a save runs", async () => {
    const user = userEvent.setup();
    const route = `PUT /api/v1/assistants/${ADA.id}/memory/decisions`;
    const { held, release } = holdAnswer();
    await openScreenAround([ADA], (_routes, answer) => ({
      [route]: async (call) => {
        await held;
        return answer(route, call);
      },
    }));

    const body = await openTopic(user, "decisions");
    await user.type(body, " Test on Bun.");
    await user.click(screen.getByRole("button", { name: "Save topic decisions" }));
    await user.clear(body);
    await user.type(body, "Use SQLite.\nShip one binary.");
    release();

    expect(await screen.findByText("28", { selector: "ul span" })).toBeDefined();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save topic decisions" })).toHaveProperty(
        "disabled",
        false,
      );
    });
    expect(body.value).toBe("Use SQLite.\nShip one binary.");
  });

  it("keeps the old text typed back while a save runs that the assistant's write refuses", async () => {
    const user = userEvent.setup();
    const route = `PUT /api/v1/assistants/${ADA.id}/memory/decisions`;
    const { held, release } = holdAnswer();
    let assistantWrote = false;
    const { api } = await openScreenAround([ADA], (_routes, answer) => ({
      [route]: async (call) => {
        await held;
        if (!assistantWrote) {
          assistantWrote = true;
          await answer(route, { ...call, body: { body: "Use Postgres." } });
        }
        return answer(route, call);
      },
    }));

    const body = await openTopic(user, "decisions");
    await user.type(body, " Test on Bun.");
    await user.click(screen.getByRole("button", { name: "Save topic decisions" }));
    await user.clear(body);
    await user.type(body, "Use SQLite.\nShip one binary.");
    release();

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(body.value).toBe("Use SQLite.\nShip one binary.");
    await user.click(await screen.findByRole("button", { name: "Save anyway" }));

    expect(await screen.findByText("Saved.")).toBeDefined();
    expect(listMemoryWrites(api, ADA.id).at(-1)?.body).toEqual({
      body: "Use SQLite.\nShip one binary.",
      expectedVersion: 2,
    });
  });

  it("refuses a new topic the assistant created meanwhile, and names it as taken", async () => {
    const user = userEvent.setup();
    const route = `PUT /api/v1/assistants/${ADA.id}/memory/travel`;
    let assistantWrote = false;
    await openScreenAround([ADA], (_routes, answer) => ({
      [route]: async (call) => {
        if (!assistantWrote) {
          assistantWrote = true;
          await answer(route, { ...call, body: { body: "Flies KLM." } });
        }
        return answer(route, call);
      },
    }));
    await findTopicRow("decisions");

    await user.click(screen.getByRole("button", { name: "New topic" }));
    await user.type(screen.getByLabelText("Topic name"), "travel");
    await user.type(screen.getByLabelText("Text"), "Takes the train.");
    await user.click(screen.getByRole("button", { name: "Save new topic" }));

    expect(
      await screen.findByText('A topic named "travel" already exists; open it to edit it.'),
    ).toBeDefined();
    expect(screen.getByLabelText<HTMLTextAreaElement>("Text").value).toBe("Takes the train.");
  });

  it("keeps a topic's edits while another topic is open", async () => {
    const user = userEvent.setup();
    await openScreen([ADA]);

    await user.type(await openTopic(user, "decisions"), " Test on Bun.");
    await openTopic(user, "people");
    const body = await openTopic(user, "decisions");

    expect(body.value).toBe("Use SQLite.\nShip one binary. Test on Bun.");
  });

  it("asks before switching assistants with unsaved memory edits", async () => {
    const user = userEvent.setup();
    await openScreen([ADA, BOB]);

    await user.type(await screen.findByLabelText("Core note"), " Has a cat.");
    await user.click(await findAssistantRow("Bob"));

    expect(screen.getByText("Discard changes to Ada?")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await selectAssistant(user, "Bob");
    await user.click(await findAssistantRow("Ada"));

    // The edit was discarded, so going back asks nothing and shows the stored note.
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLTextAreaElement>("Core note").value).toBe(
        "Rogier lives in Amsterdam. Prefers short answers.",
      );
    });
  });
});

/** Returns the names of the listed topics, in order. */
const queryTopicNames = (): readonly string[] =>
  screen
    .queryAllByRole("button", { expanded: false })
    .concat(screen.queryAllByRole("button", { expanded: true }))
    .filter((row) => row.closest("ul") !== null)
    .map((row) => row.querySelector("span")?.textContent ?? "")
    .sort();
