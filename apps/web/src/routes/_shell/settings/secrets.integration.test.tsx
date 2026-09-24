/**
 * Tests for Settings > Secrets: what the screen shows about the secrets the
 * controller stores, and what each button sends.
 *
 * The screen lists references only. The API never returns a value, so the
 * only value a test can show the screen is one the user just typed, and that
 * value must not appear anywhere on the page afterwards. The secrecy checks
 * below look at what the user could see on the page, not at data shapes.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { formatStamp } from "@hercule/client-core";
import {
  expectInDocumentOrder,
  readPageText,
  renderApp,
  stubApi,
  type Handler,
} from "../../../app/testing";

const ZONE = "Europe/Amsterdam";

interface Ref {
  readonly ownerKind: string;
  readonly ownerId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly rotatedAt?: string;
}

/** A connection's personal access token, rotated once since it was set. */
const PAT: Ref = {
  ownerKind: "connection",
  ownerId: "0199c0ff-eeee-7000-8000-000000000001",
  name: "pat",
  createdAt: "2026-09-01T08:15:00.000Z",
  rotatedAt: "2026-09-11T17:21:00.000Z",
};

/** The same connection's OAuth tokens, never rotated. */
const TOKENS: Ref = {
  ownerKind: "connection",
  ownerId: PAT.ownerId,
  name: "oauth.tokens",
  createdAt: "2026-09-02T09:30:00.000Z",
};

/** The controller's own key material, which the user may not write. */
const SIGNING_KEY: Ref = {
  ownerKind: "core",
  ownerId: "controller",
  name: "controller.signing-key",
  createdAt: "2026-08-20T06:00:00.000Z",
};

/** A secret owned by a plugin, so a second owner of a second kind. */
const CLIENT_SECRET: Ref = {
  ownerKind: "plugin",
  ownerId: "github",
  name: "clientSecret",
  createdAt: "2026-09-03T10:45:00.000Z",
};

const formatStampOrFail = (at: string): string => {
  const reading = formatStamp(new Date(at), ZONE);
  if (reading === undefined) throw new Error(`no stamp for ${at}`);
  return reading;
};

const buildSecretPath = (ref: Pick<Ref, "ownerKind" | "ownerId" | "name">): string =>
  `/api/v1/secrets/${ref.ownerKind}/${ref.ownerId}/${ref.name}`;

/** Builds a stub controller that returns `refs` and accepts every write to them. */
const buildController = (
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
      [`PUT ${buildSecretPath(ref)}`]: { body: { ...ref, rotatedAt: "2026-09-13T12:00:00.000Z" } },
      [`DELETE ${buildSecretPath(ref)}`]: { body: {} },
    }),
    {},
  ),
  ...extra,
});

const openApp = async (refs: readonly Ref[], extra: Readonly<Record<string, Handler>> = {}) => {
  const held = [...refs];
  const api = stubApi(buildController(() => held, extra));
  const app = await renderApp({ path: "/settings/secrets", api: api.fetch, token: "held" });
  return {
    ...app,
    api,
    /** Removes `ref` from what the controller returns, as a delete would. */
    drop: (ref: Ref) => {
      const at = held.findIndex((each) => each.ownerId === ref.ownerId && each.name === ref.name);
      held.splice(at, 1);
    },
  };
};

/**
 * Returns the writes this screen made, in order. The shell opens a live
 * connection on every screen and fetches a ticket for it with a POST. This
 * screen did not make that request, so it is left out.
 */
const listWrites = (api: { readonly calls: readonly { method: string; path: string }[] }) =>
  api.calls.filter((call) => call.method !== "GET" && !call.path.endsWith("/auth/ws-ticket"));

const countSecretReads = (api: { readonly calls: readonly { path: string }[] }) =>
  api.calls.filter((call) => call.path === "/api/v1/secrets").length;

/** Finds the row of one secret: the list item that holds its name. */
const findSecretRow = async (ref: Ref): Promise<HTMLElement> => {
  await screen.findByText(ref.name);
  const row = screen
    .getAllByRole("listitem")
    .find((candidate) => within(candidate).queryByText(ref.name) !== null);
  if (row === undefined) throw new Error(`no row for ${ref.ownerId}/${ref.name}`);
  return row;
};

describe("Settings > Secrets", () => {
  it("shows each secret's owner, name and when it was last written", async () => {
    await openApp([PAT, TOKENS, CLIENT_SECRET]);

    const pat = readPageText(await findSecretRow(PAT));
    expect(pat).toContain("connection");
    expect(pat).toContain(PAT.ownerId);
    expect(pat).toContain("pat");
    // Rotated since it was set, so the row shows the rotation time.
    expect(pat).toContain(formatStampOrFail(PAT.rotatedAt!));

    const tokens = readPageText(await findSecretRow(TOKENS));
    expect(tokens).toContain("oauth.tokens");
    expect(tokens).toContain(formatStampOrFail(TOKENS.createdAt));

    const plugin = readPageText(await findSecretRow(CLIENT_SECRET));
    expect(plugin).toContain("plugin");
    expect(plugin).toContain("github");
    expect(plugin).toContain("clientSecret");
    expect(plugin).toContain(formatStampOrFail(CLIENT_SECRET.createdAt));
  });

  it("does not show a typed value anywhere once it is written", async () => {
    const user = userEvent.setup();
    const VALUE = "ghp-zzz-never-shown-4f19d";
    const { api } = await openApp([PAT, TOKENS, CLIENT_SECRET]);

    const row = await findSecretRow(PAT);
    await user.click(within(row).getByRole("button", { name: "Rotate" }));
    await user.type(await screen.findByLabelText("New value"), VALUE);
    const save = screen.getByRole("button", { name: "Save" });
    expectInDocumentOrder([within(row).getByRole("button", { name: "Cancel" }), save]);
    await user.click(save);

    await waitFor(() => {
      expect(listWrites(api)).toHaveLength(1);
    });
    // Not in the page text, and not in any input either. An input's value is
    // not part of the text content, so checking the text alone proves nothing.
    expect(readPageText()).not.toContain(VALUE);
    expect(screen.queryByDisplayValue(VALUE)).toBeNull();
  });

  it("rotates a secret and fetches the list again", async () => {
    const user = userEvent.setup();
    const { api } = await openApp([PAT, TOKENS, CLIENT_SECRET]);
    const before = countSecretReads(api);

    const row = await findSecretRow(PAT);
    await user.click(within(row).getByRole("button", { name: "Rotate" }));
    await user.type(await screen.findByLabelText("New value"), "rotated-1");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(listWrites(api)).toHaveLength(1);
    });
    const written = api.calls.filter((call) => call.method === "PUT");
    expect(written.map((call) => call.path)).toEqual([buildSecretPath(PAT)]);
    expect(written[0]?.body).toEqual({ value: "rotated-1" });

    // The row comes from a refetched list, not from the write's response.
    await waitFor(() => {
      expect(countSecretReads(api)).toBeGreaterThan(before);
    });
  });

  it("asks for a new value before it writes anything", async () => {
    const user = userEvent.setup();
    const { api } = await openApp([PAT]);

    await user.click(within(await findSecretRow(PAT)).getByRole("button", { name: "Rotate" }));

    expect(await screen.findByLabelText("New value")).toBeDefined();
    expect(listWrites(api)).toEqual([]);
  });

  it("asks for confirmation before it deletes a secret, and lets the user cancel", async () => {
    const user = userEvent.setup();
    const { api } = await openApp([PAT, TOKENS, CLIENT_SECRET]);

    const row = await findSecretRow(TOKENS);
    await user.click(within(row).getByRole("button", { name: "Delete" }));

    expect(readPageText(row)).toContain("Delete this secret? Its value cannot be recovered.");
    expect(listWrites(api)).toEqual([]);
    // Cancel comes before Confirm.
    const cancel = within(row).getByRole("button", { name: "Cancel" });
    expectInDocumentOrder([cancel, within(row).getByRole("button", { name: "Confirm" })]);

    await user.click(cancel);

    expect(listWrites(api)).toEqual([]);
    expect(screen.getByText(TOKENS.name)).toBeDefined();
  });

  it("deletes a secret once confirmed, and removes its row", async () => {
    const user = userEvent.setup();
    const { api, drop } = await openApp([PAT, TOKENS, CLIENT_SECRET]);

    const row = await findSecretRow(TOKENS);
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    drop(TOKENS);
    await user.click(within(row).getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(listWrites(api).map((call) => `${call.method} ${call.path}`)).toEqual([
        `DELETE ${buildSecretPath(TOKENS)}`,
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByText(TOKENS.name)).toBeNull();
    });
    expect(screen.getByText(PAT.name)).toBeDefined();
  });
});

describe("Settings > Secrets > setting a secret", () => {
  const fill = async (
    user: ReturnType<typeof userEvent.setup>,
    values: { kind: string; ownerId: string; name: string; value: string },
  ): Promise<void> => {
    await user.selectOptions(screen.getByLabelText("Owner kind"), values.kind);
    await user.type(screen.getByLabelText("Owner id"), values.ownerId);
    await user.type(screen.getByLabelText("Name"), values.name);
    await user.type(screen.getByLabelText("Value"), values.value);
  };

  it("writes the secret the form was filled in with", async () => {
    const user = userEvent.setup();
    const { api } = await openApp([PAT], {
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
      expect(listWrites(api)).toHaveLength(1);
    });
    expect(listWrites(api)[0]).toMatchObject({
      method: "PUT",
      path: "/api/v1/secrets/runner/moss/join-token",
    });
    expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({
      value: "jt-never-shown-771",
    });
    expect(readPageText()).not.toContain("jt-never-shown-771");
    expect(screen.queryByDisplayValue("jt-never-shown-771")).toBeNull();
  });

  it("shows no actions for the controller's own key material", async () => {
    await openApp([PAT, SIGNING_KEY]);

    const core = await findSecretRow(SIGNING_KEY);
    expect(within(core).queryByRole("button", { name: "Rotate" })).toBeNull();
    expect(within(core).queryByRole("button", { name: "Delete" })).toBeNull();
    // Rows the user may write still show both buttons.
    expect(within(await findSecretRow(PAT)).getByRole("button", { name: "Rotate" })).toBeDefined();
  });

  it("offers the owner kinds a user may write, and not the controller's own", async () => {
    await openApp([PAT]);

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
  it("explains what a secret is, rather than showing an empty list", async () => {
    await openApp([]);

    expect(readPageText()).toContain("No secrets are stored.");
  });
});
