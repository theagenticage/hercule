/**
 * Tests the assistant step of onboarding (`/onboarding/assistant`) against a
 * stubbed controller. The step names the assistant that setup created and
 * only then records itself as done. On a fresh install there is no assistant
 * (the first Provider Account creates it), so the step explains that and
 * records itself without creating one.
 */
import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Assistant } from "@hercule/contract";
import {
  buildErrorBody,
  expectInDocumentOrder,
  renderApp,
  stubApi,
  type Handler,
} from "../../app/testing";

const HERCULE: Assistant = {
  id: "01a06d02-a000-7000-8000-000000000001",
  name: "Hercule",
  systemPrompt: "You are a helpful assistant.",
  providerAccountId: "01a06d02-1000-7000-8000-000000000001",
  harnessId: null,
  permissionProfileId: "01a06d02-2000-7000-8000-000000000001",
  accessMode: "full-access",
  model: null,
  disallowedTools: [],
  unenforced: [],
  heartbeat: {
    enabled: false,
    schedule: "0 7-23 * * *",
    prompt: "Check in.",
    target: "web",
  },
  rotation: { contextFraction: 0.7, maxContextTokens: 200000, dailyAt: "04:00" },
  reply: "turn-end",
  mainConversationId: "01a06d02-c000-7000-8000-000000000001",
  createdAt: "2026-09-25T09:00:00.000Z",
  updatedAt: "2026-09-25T09:00:00.000Z",
};

const ASSISTANT_PATH = `/api/v1/assistants/${HERCULE.id}`;

/**
 * Returns stub routes for a controller whose user has confirmed the timezone
 * and nothing else. The user settings are kept in memory, so a `PATCH` is
 * read back by the entry guard on the next navigation. `assistants` is what
 * `GET /api/v1/assistants` returns at first; a rename changes it, so a later
 * read returns what the write left.
 */
const buildController = (
  assistants: readonly Assistant[],
  extra: Readonly<Record<string, Handler>> = {},
): Readonly<Record<string, Handler>> => {
  let user: Record<string, unknown> = {
    timezone: "Europe/Amsterdam",
    "onboarding.completedSteps": ["timezone"],
  };
  let list = assistants;
  return {
    "GET /api/v1/setup": { body: { complete: true } },
    "POST /api/v1/auth/login": {
      body: { token: "minted", expiresAt: "2026-10-04T00:00:00.000Z" },
    },
    "GET /api/v1/settings": () => ({ body: { controller: {}, user } }),
    "PATCH /api/v1/settings": (call) => {
      user = { ...user, ...(call.body as { user: Record<string, unknown> }).user };
      return { body: { controller: {}, user } };
    },
    "GET /api/v1/assistants": () => ({ body: { items: list } }),
    [`PATCH ${ASSISTANT_PATH}`]: (call) => {
      const renamed = { ...HERCULE, ...(call.body as Partial<Assistant>) };
      list = list.map((each) => (each.id === renamed.id ? renamed : each));
      return { body: renamed };
    },
    ...extra,
  };
};

/** Opens the app signed in, which the entry guard sends to the assistant step. */
const openStep = async (
  assistants: readonly Assistant[],
  extra: Readonly<Record<string, Handler>> = {},
) => {
  const api = stubApi(buildController(assistants, extra));
  const app = await renderApp({ path: "/", api: api.fetch, token: "held" });
  await waitFor(() => {
    expect(app.router.state.location.pathname).toBe("/onboarding/assistant");
  });
  return { ...app, api };
};

/** Replaces the text in the Name field with `name`, and presses Continue. */
const submitName = async (name: string) => {
  const user = userEvent.setup();
  const field = await screen.findByLabelText<HTMLInputElement>("Name");
  await user.clear(field);
  await user.type(field, name);
  await user.click(screen.getByRole("button", { name: "Continue" }));
};

describe("the assistant step", () => {
  it("is where a user who has only confirmed the timezone lands when they log in", async () => {
    const api = stubApi(buildController([HERCULE]));
    const { router } = await renderApp({ path: "/login", api: api.fetch });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Username"), "rogier");
    await user.type(screen.getByLabelText("Password"), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/onboarding/assistant");
    });
  });

  it("asks for the assistant's name, with the current name filled in", async () => {
    await openStep([HERCULE]);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Name your assistant" }),
    ).toBeDefined();
    expect(
      screen.getByText(
        "Your assistant is an agent you talk to in this controller. You can rename it later in Settings > Assistants.",
      ),
    ).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Hercule");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDefined();
  });

  it("renames the assistant, then records the step, and lands on Home", async () => {
    const { api, router } = await openStep([HERCULE]);

    await submitName("Ada");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
    const renamed = api.calls.findIndex(
      (call) => call.method === "PATCH" && call.path === ASSISTANT_PATH,
    );
    const recorded = api.calls.findIndex(
      (call) => call.method === "PATCH" && call.path === "/api/v1/settings",
    );
    expect(api.calls[renamed]?.body).toEqual({ name: "Ada" });
    expect(api.calls[recorded]?.body).toMatchObject({
      user: { "onboarding.completedSteps": ["timezone", "assistant"] },
    });
    expect(renamed).toBeGreaterThanOrEqual(0);
    expect(recorded).toBeGreaterThan(renamed);
    expect(
      api.calls.some((call) => call.method === "POST" && call.path === "/api/v1/assistants"),
    ).toBe(false);
  });

  it("explains where the assistant comes from when there is none, and lets the user continue", async () => {
    const { api, router } = await openStep([]);

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Your assistant comes with your first account",
      }),
    ).toBeDefined();
    expect(screen.queryByLabelText("Name")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
    const recorded = api.calls.find(
      (call) => call.method === "PATCH" && call.path === "/api/v1/settings",
    );
    expect(recorded?.body).toMatchObject({
      user: { "onboarding.completedSteps": ["timezone", "assistant"] },
    });
    expect(
      api.calls.some((call) => call.method !== "GET" && call.path.includes("assistants")),
    ).toBe(false);
  });

  it("disables Continue while the name is empty", async () => {
    await openStep([HERCULE]);

    await userEvent.setup().clear(await screen.findByLabelText("Name"));

    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Continue" }).disabled).toBe(true);
  });

  it("shows a refused rename under the field, records no step and stays on the step", async () => {
    const { api, router } = await openStep([HERCULE], {
      [`PATCH ${ASSISTANT_PATH}`]: {
        status: 500,
        body: buildErrorBody("internal", "the database is locked"),
      },
    });

    await submitName("Ada");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("the database is locked");
    expectInDocumentOrder([screen.getByLabelText("Name"), alert]);
    expect(
      api.calls.some((call) => call.method === "PATCH" && call.path === "/api/v1/settings"),
    ).toBe(false);
    expect(router.state.location.pathname).toBe("/onboarding/assistant");
  });

  it("shows a refused record under the explanation and stays on the step when there is no assistant", async () => {
    const { router } = await openStep([], {
      "PATCH /api/v1/settings": {
        status: 500,
        body: buildErrorBody("internal", "the database is locked"),
      },
    });

    await userEvent.setup().click(await screen.findByRole("button", { name: "Continue" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("the database is locked");
    expect(router.state.location.pathname).toBe("/onboarding/assistant");
  });

  // Added in review round 1 of #92 slice 3 (D-83). The sidebar reads the
  // name from the assistants list, which kept the old name after the rename
  // until something else refetched it.
  it("reads the assistants list again after the rename, before it records the step", async () => {
    const { api, router } = await openStep([HERCULE]);

    await submitName("Ada");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
    const renamed = api.calls.findIndex(
      (call) => call.method === "PATCH" && call.path === ASSISTANT_PATH,
    );
    const recorded = api.calls.findIndex(
      (call) => call.method === "PATCH" && call.path === "/api/v1/settings",
    );
    // Home, which the step lands on, reads the list on its own, so only a
    // read before the step is recorded shows that the step refreshed it.
    const refreshed = api.calls.some(
      (call, index) =>
        call.method === "GET" &&
        call.path === "/api/v1/assistants" &&
        index > renamed &&
        index < recorded,
    );
    expect(refreshed).toBe(true);
  });

  // Added in review round 1 of #92 slice 3 (F-73). `isPending` reaches the
  // step a tick after `mutate`, so two submits in one tick both wrote.
  it("writes once when the form is submitted twice before the first write is answered", async () => {
    let release = (): void => {};
    const { api } = await openStep([HERCULE], {
      [`PATCH ${ASSISTANT_PATH}`]: () =>
        new Promise((resolve) => {
          release = () => resolve({ body: { ...HERCULE, name: "Hercule" } });
        }),
    });

    const field = await screen.findByLabelText<HTMLInputElement>("Name");
    fireEvent.submit(field.form!);
    fireEvent.submit(field.form!);
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    expect(
      api.calls.filter((call) => call.method === "PATCH" && call.path === ASSISTANT_PATH),
    ).toHaveLength(1);
    release();
  });
});
