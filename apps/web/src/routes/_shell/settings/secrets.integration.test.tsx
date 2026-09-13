/**
 * Settings > Secrets: what the screen says about the secrets the controller
 * holds, and what a click sends.
 *
 * The screen is a list of references. No read in the API carries a value, so
 * the only value a test can put in front of it is one the user just typed -
 * and that one must not come back out anywhere on the page. Every assertion
 * about secrecy below is about text the user could read, not about a shape.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { formatStamp } from "@hydra/client-core";
import { renderApp, stubApi, type Handler } from "../../../app/testing";

const ZONE = "Europe/Amsterdam";

interface Ref {
  readonly ownerKind: string;
  readonly ownerId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly rotatedAt?: string;
}

/** A connection's pat, rotated once since it was set. */
const PAT: Ref = {
  ownerKind: "connection",
  ownerId: "0199c0ff-eeee-7000-8000-000000000001",
  name: "pat",
  createdAt: "2026-09-01T08:15:00.000Z",
  rotatedAt: "2026-09-11T17:21:00.000Z",
};

/** The same connection's OAuth token set, never rotated. */
const TOKENS: Ref = {
  ownerKind: "connection",
  ownerId: PAT.ownerId,
  name: "oauth.tokens",
  createdAt: "2026-09-02T09:30:00.000Z",
};

/** The controller's own key material, which no user write may touch. */
const SIGNING_KEY: Ref = {
  ownerKind: "core",
  ownerId: "controller",
  name: "controller.signing-key",
  createdAt: "2026-08-20T06:00:00.000Z",
};

/** A plugin-owned secret: a second owner, of a second kind. */
const CLIENT_SECRET: Ref = {
  ownerKind: "plugin",
  ownerId: "github",
  name: "clientSecret",
  createdAt: "2026-09-03T10:45:00.000Z",
};

const stamp = (at: string): string => {
  const reading = formatStamp(new Date(at), ZONE);
  if (reading === undefined) throw new Error(`no stamp for ${at}`);
  return reading;
};

const pathOf = (ref: Pick<Ref, "ownerKind" | "ownerId" | "name">): string =>
  `/api/v1/secrets/${ref.ownerKind}/${ref.ownerId}/${ref.name}`;

/** A controller holding `refs`, with every write on them answered. */
const controller = (
  refs: () => readonly Ref[],
  extra: Readonly<Record<string, Handler>> = {},
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: {
      controller: {},
      user: { "onboarding.completedSteps": ["timezone"], timezone: ZONE },
    },
  },
  "GET /api/v1/secrets": () => ({ body: { items: refs() } }),
  ...refs().reduce<Record<string, Handler>>(
    (all, ref) => ({
      ...all,
      [`PUT ${pathOf(ref)}`]: { body: { ...ref, rotatedAt: "2026-09-13T12:00:00.000Z" } },
      [`DELETE ${pathOf(ref)}`]: { body: {} },
    }),
    {},
  ),
  ...extra,
});

const open = async (refs: readonly Ref[], extra: Readonly<Record<string, Handler>> = {}) => {
  const held = [...refs];
  const api = stubApi(controller(() => held, extra));
  const app = await renderApp({ path: "/settings/secrets", api: api.fetch, token: "held" });
  return {
    ...app,
    api,
    /** Drops a reference from what the controller answers with, as a delete would. */
    drop: (ref: Ref) => {
      const at = held.findIndex((each) => each.ownerId === ref.ownerId && each.name === ref.name);
      held.splice(at, 1);
    },
  };
};

/** The page's text with its whitespace collapsed, the way a reader sees it. */
const reading = (element: HTMLElement | null = document.body): string =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();

/**
 * The writes this screen made, in order. The shell opens a live connection on
 * every screen inside it, and the ticket it fetches is a POST nobody on this
 * screen asked for, so it is not one of them.
 */
const writes = (api: { readonly calls: readonly { method: string; path: string }[] }) =>
  api.calls.filter((call) => call.method !== "GET" && !call.path.endsWith("/auth/ws-ticket"));

const listings = (api: { readonly calls: readonly { path: string }[] }) =>
  api.calls.filter((call) => call.path === "/api/v1/secrets").length;

/** The row about one reference: the list item its name is in. */
const rowFor = async (ref: Ref): Promise<HTMLElement> => {
  await screen.findByText(ref.name);
  const row = screen
    .getAllByRole("listitem")
    .find((candidate) => within(candidate).queryByText(ref.name) !== null);
  if (row === undefined) throw new Error(`no row for ${ref.ownerId}/${ref.name}`);
  return row;
};

describe("Settings > Secrets", () => {
  it("says who owns each secret, what it is called and when it was last written", async () => {
    await open([PAT, TOKENS, CLIENT_SECRET]);

    const pat = reading(await rowFor(PAT));
    expect(pat).toContain("connection");
    expect(pat).toContain(PAT.ownerId);
    expect(pat).toContain("pat");
    // Rotated since it was set, so the reading is the rotation.
    expect(pat).toContain(stamp(PAT.rotatedAt!));

    const tokens = reading(await rowFor(TOKENS));
    expect(tokens).toContain("oauth.tokens");
    expect(tokens).toContain(stamp(TOKENS.createdAt));

    const plugin = reading(await rowFor(CLIENT_SECRET));
    expect(plugin).toContain("plugin");
    expect(plugin).toContain("github");
    expect(plugin).toContain("clientSecret");
    expect(plugin).toContain(stamp(CLIENT_SECRET.createdAt));
  });

  it("keeps a value the user typed off the page once it is written", async () => {
    const user = userEvent.setup();
    const VALUE = "ghp-zzz-never-shown-4f19d";
    const { api } = await open([PAT, TOKENS, CLIENT_SECRET]);

    const row = await rowFor(PAT);
    await user.click(within(row).getByRole("button", { name: "Rotate" }));
    await user.type(await screen.findByLabelText("New value"), VALUE);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(writes(api)).toHaveLength(1);
    });
    // Not in the text the page reads out, and not held in a field either: an
    // input's value is not text content, so the reading alone would prove
    // nothing.
    expect(reading()).not.toContain(VALUE);
    expect(screen.queryByDisplayValue(VALUE)).toBeNull();
  });

  it("rotates a secret and reads the list back", async () => {
    const user = userEvent.setup();
    const { api } = await open([PAT, TOKENS, CLIENT_SECRET]);
    const before = listings(api);

    const row = await rowFor(PAT);
    await user.click(within(row).getByRole("button", { name: "Rotate" }));
    await user.type(await screen.findByLabelText("New value"), "rotated-1");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(writes(api)).toHaveLength(1);
    });
    const written = api.calls.filter((call) => call.method === "PUT");
    expect(written.map((call) => call.path)).toEqual([pathOf(PAT)]);
    expect(written[0]?.body).toEqual({ value: "rotated-1" });

    // The row's reading comes from a fresh listing, not from the answer.
    await waitFor(() => {
      expect(listings(api)).toBeGreaterThan(before);
    });
  });

  it("asks for a value before it writes one", async () => {
    const user = userEvent.setup();
    const { api } = await open([PAT]);

    await user.click(within(await rowFor(PAT)).getByRole("button", { name: "Rotate" }));

    expect(await screen.findByLabelText("New value")).toBeDefined();
    expect(writes(api)).toEqual([]);
  });

  it("asks before it deletes a secret, and lets the user back out", async () => {
    const user = userEvent.setup();
    const { api } = await open([PAT, TOKENS, CLIENT_SECRET]);

    const row = await rowFor(TOKENS);
    await user.click(within(row).getByRole("button", { name: "Delete" }));

    expect(reading(row)).toContain("Delete this secret? Its value cannot be recovered.");
    expect(writes(api)).toEqual([]);

    await user.click(within(row).getByRole("button", { name: "Cancel" }));

    expect(writes(api)).toEqual([]);
    expect(screen.getByText(TOKENS.name)).toBeDefined();
  });

  it("deletes a secret once it is confirmed, and drops its row", async () => {
    const user = userEvent.setup();
    const { api, drop } = await open([PAT, TOKENS, CLIENT_SECRET]);

    const row = await rowFor(TOKENS);
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    drop(TOKENS);
    await user.click(within(row).getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(writes(api).map((call) => `${call.method} ${call.path}`)).toEqual([
        `DELETE ${pathOf(TOKENS)}`,
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByText(TOKENS.name)).toBeNull();
    });
    expect(screen.getByText(PAT.name)).toBeDefined();
  });
});

describe("Settings > Secrets > setting one", () => {
  const fill = async (
    user: ReturnType<typeof userEvent.setup>,
    values: { kind: string; ownerId: string; name: string; value: string },
  ): Promise<void> => {
    await user.selectOptions(screen.getByLabelText("Owner kind"), values.kind);
    await user.type(screen.getByLabelText("Owner id"), values.ownerId);
    await user.type(screen.getByLabelText("Name"), values.name);
    await user.type(screen.getByLabelText("Value"), values.value);
  };

  it("writes the secret the form was filled with", async () => {
    const user = userEvent.setup();
    const { api } = await open([PAT], {
      "PUT /api/v1/secrets/runner/moss/join-token": {
        body: {
          ownerKind: "runner",
          ownerId: "moss",
          name: "join-token",
          createdAt: "2026-09-13T12:00:00.000Z",
        },
      },
    });

    await fill(user, {
      kind: "runner",
      ownerId: "moss",
      name: "join-token",
      value: "jt-never-shown-771",
    });
    await user.click(screen.getByRole("button", { name: "Set secret" }));

    await waitFor(() => {
      expect(writes(api)).toHaveLength(1);
    });
    expect(writes(api)[0]).toMatchObject({
      method: "PUT",
      path: "/api/v1/secrets/runner/moss/join-token",
    });
    expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({
      value: "jt-never-shown-771",
    });
    expect(reading()).not.toContain("jt-never-shown-771");
    expect(screen.queryByDisplayValue("jt-never-shown-771")).toBeNull();
  });

  it("offers nothing to do to the controller's own key material", async () => {
    await open([PAT, SIGNING_KEY]);

    const core = await rowFor(SIGNING_KEY);
    expect(within(core).queryByRole("button", { name: "Rotate" })).toBeNull();
    expect(within(core).queryByRole("button", { name: "Delete" })).toBeNull();
    // The rows that may be written still offer both.
    expect(within(await rowFor(PAT)).getByRole("button", { name: "Rotate" })).toBeDefined();
  });

  it("offers the owner kinds a user may write, and not the controller's own", async () => {
    await open([PAT]);

    const kinds = [...screen.getByLabelText<HTMLSelectElement>("Owner kind").options].map(
      (option) => option.value,
    );
    expect(kinds).toEqual(
      expect.arrayContaining(["plugin", "connection", "runner", "provider-instance"]),
    );
    expect(kinds).not.toContain("core");
  });
});

describe("Settings > Secrets > nothing stored", () => {
  it("says what a secret is, rather than showing an empty list", async () => {
    await open([]);

    expect(reading()).toContain("No secrets are stored.");
  });
});
