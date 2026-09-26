/**
 * Tests for Settings > Assistants against a stubbed controller: the list of
 * assistants, the form that edits the selected one, "New assistant", and
 * deleting an assistant after a confirmation.
 *
 * The stub keeps the assistants in memory, so a list read after a create, an
 * update or a delete returns what the writes left.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Assistant, Profile, ProviderInstance } from "@hercule/contract";
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

const buildProviderInstance = (id: string, displayName: string): ProviderInstance => ({
  id,
  providerId: "claude-code",
  secretFields: [],
  name: displayName,
  config: {},
  displayName,
  binaryName: "claude",
  declared: {
    steering: "native",
    fork: "native",
    modelSwitch: "in-session",
    accessModes: {
      "approval-required": "native",
      "auto-accept-edits": "native",
      auto: "native",
      "full-access": "native",
    },
    mcpPassthrough: "native",
    disallowedTools: "native",
    structuredOutput: "supported",
  },
  snapshots: [],
  createdAt: AT,
  updatedAt: AT,
});

const INSTANCE_PERSONAL = buildProviderInstance(
  "01a06d02-1000-7000-8000-000000000001",
  "Claude Code",
);
const INSTANCE_WORK = buildProviderInstance(
  "01a06d02-1000-7000-8000-000000000002",
  "Claude Code (work)",
);
const INSTANCES: readonly ProviderInstance[] = [INSTANCE_PERSONAL, INSTANCE_WORK];

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
  fields: Pick<Assistant, "id" | "name" | "systemPrompt"> & Partial<Assistant>,
): Assistant => ({
  instanceId: INSTANCE_PERSONAL.id,
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
  name: "Ada",
  systemPrompt: "You are Ada. Answer briefly.",
});

const BOB = buildAssistant({
  id: "01a06d02-a000-7000-8000-000000000002",
  name: "Bob",
  systemPrompt: "You are Bob. Answer at length.",
  instanceId: INSTANCE_WORK.id,
  permissionProfileId: PROFILE_UNRESTRICTED.id,
  accessMode: "auto",
  reply: "segments",
});

/** What the controller returns for `assistant.create { name: "Hercule" }`. */
const CREATED = buildAssistant({
  id: "01a06d02-a000-7000-8000-000000000003",
  name: "Hercule",
  systemPrompt: "You are a personal assistant running inside the user's own controller.",
});

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
    "GET /api/v1/providers": { body: INSTANCES },
    "GET /api/v1/profiles": { body: { items: PROFILES } },
    "GET /api/v1/runners": { body: { items: [] } },
    "GET /api/v1/assistants": () => ({ body: { items: list } }),
    "POST /api/v1/assistants": (call) => {
      const created = { ...CREATED, ...(call.body as Partial<Assistant>) };
      list = [...list, created];
      return { body: created };
    },
    ...Object.fromEntries(perAssistant),
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

/** Returns the writes the screen sent to the assistants endpoints, in order. */
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

const EMPTY_HEADLINE = "No assistant has been created yet.";
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

    const instance = screen.getByLabelText<HTMLSelectElement>("Provider instance");
    expect([...instance.options].map((option) => option.textContent)).toEqual(
      INSTANCES.map((each) => each.displayName),
    );
    expect(instance.value).toBe(INSTANCE_WORK.id);

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
    ).toEqual(["approval-required", "auto-accept-edits", "auto", "full-access"]);
    expect(readCheckedSegment("Access mode")).toBe("auto");

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

  it("saves only the changed persona, provider instance, permission profile and access mode", async () => {
    const user = userEvent.setup();
    const { api } = await openScreen([ADA, BOB]);
    await selectAssistant(user, "Ada");

    const persona = screen.getByLabelText("Persona");
    await user.clear(persona);
    await user.type(persona, "You are Ada.{Enter}Answer in Dutch.");
    await user.selectOptions(screen.getByLabelText("Provider instance"), INSTANCE_WORK.displayName);
    await user.selectOptions(
      screen.getByLabelText("Permission profile"),
      PROFILE_UNRESTRICTED.name,
    );
    await user.click(
      within(screen.getByRole("radiogroup", { name: "Access mode" })).getByRole("radio", {
        name: "full-access",
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
      instanceId: INSTANCE_WORK.id,
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

  it("shows a stored instance and profile that are no longer listed as not found, and never sends them", async () => {
    const user = userEvent.setup();
    const orphan = {
      ...ADA,
      instanceId: "01a06d02-1000-7000-8000-0000000000ff",
      permissionProfileId: "01a06d02-3000-7000-8000-0000000000ee",
    };
    const { api } = await openScreen([orphan, BOB]);
    await selectAssistant(user, "Ada");

    const instance = screen.getByLabelText<HTMLSelectElement>("Provider instance");
    expect(instance.value).toBe(orphan.instanceId);
    expect(instance.selectedOptions[0]?.textContent).toBe("000000ff (not found)");
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
