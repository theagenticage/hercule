/**
 * The runner page: everything one machine is, and every move its owner can
 * make on it, over a stubbed controller.
 *
 * A row in the fleet list is a summary; this page is where a machine is
 * changed, so the assertions here are about the two directions at once - what
 * the reader is told about the machine, and what leaves the browser when they
 * act on it. A move that only looked right on screen while sending the wrong
 * thing, or the right thing while leaving the page showing the old machine,
 * would both be wrong.
 *
 * Retire is the one move that cannot be taken back, so it is held to the
 * question it asks: what it says when the controller cannot reach the machine,
 * what it says when the fleet is about to lose its default, and that nothing
 * leaves the browser until the question is answered.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { formatStamp } from "@hydra/client-core";
import { envelope, renderApp, stubApi, type Call, type Handler } from "../../../app/testing";
import { CONTROLLER_VERSION, GIB, MOSS as MACHINE, ZONE, type Fixture } from "./-fixtures";

/** The machine this page is opened on, away since it was last seen. */
const MOSS: Fixture = { ...MACHINE, connectivity: "offline", maxConcurrentSessions: 7 };

/** The same machine, connected, which is what the live moves need. */
const ONLINE: Fixture = { ...MOSS, connectivity: "online" };

/** A machine the controller has lost: retiring it is the case that forces. */
const LOST: Fixture = { ...MOSS, connectivity: "unreachable" };

/** A controller answering for itself, for the runner given, and for its writes. */
const controller = (
  runner: Fixture,
  options: {
    readonly defaultRunnerId?: string | null;
    readonly extra?: Readonly<Record<string, Handler>>;
  } = {},
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: {
      controller: {},
      user: { "onboarding.completedSteps": ["timezone"], timezone: ZONE },
    },
  },
  "GET /api/v1/controller": {
    body: {
      id: "01a06d02-a000-7000-8000-000000000001",
      publicKey: "bm90LWEta2V5",
      version: CONTROLLER_VERSION,
      defaultRunnerId: options.defaultRunnerId ?? null,
    },
  },
  [`GET /api/v1/runners/${runner.id}`]: { body: runner },
  ...options.extra,
});

const open = async (
  runner: Fixture,
  options: {
    readonly defaultRunnerId?: string | null;
    readonly extra?: Readonly<Record<string, Handler>>;
  } = {},
) => {
  const api = stubApi(controller(runner, options));
  const app = await renderApp({ path: `/fleet/${runner.id}`, api: api.fetch, token: "held" });
  return { ...app, api };
};

/** The page's text with its whitespace collapsed, the way a reader sees it. */
const reading = (element: HTMLElement | null = document.body): string =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();

/** Everything this page sent about the runner, in order. */
const writesTo = (api: { readonly calls: readonly Call[] }, id: string) =>
  api.calls.filter(
    (call) => call.method !== "GET" && call.path.startsWith(`/api/v1/runners/${id}`),
  );

/**
 * Whether a size is on screen, as the whole number of gibibytes the fixtures
 * are all round multiples of.
 */
const showsSize = (text: string, bytes: number): boolean =>
  new RegExp(`(^|[^\\d.])${(bytes / 1024 ** 3).toFixed(0)} ?GiB`).test(text);

/** The field holding the machine's name. */
const nameField = () => screen.getByLabelText<HTMLInputElement>(/name/i);

/** The control saying whether the machine is the owner's alone. */
const reservedField = () => screen.getByRole("checkbox", { name: /personal machine|reserved/i });

/** Whether a control is ticked, whichever way the control says so. */
const ticked = (control: HTMLElement): boolean =>
  control.getAttribute("aria-checked") === "true" || (control as HTMLInputElement).checked;

/**
 * The smallest part of the page holding both a message and the field it is
 * about. A message is beside its field when that part holds no other field.
 */
const around = (message: HTMLElement, field: HTMLElement): HTMLElement => {
  let group: HTMLElement = message;
  while (group.parentElement !== null && !group.contains(field)) {
    group = group.parentElement;
  }
  return group;
};

const action = (name: RegExp) => screen.getByRole("button", { name });

describe("Runner", () => {
  it("says what the machine is, where it stands and what it may run", async () => {
    await open(MOSS);

    const shown = await waitFor(() => {
      const text = reading();
      expect(text).toContain(MOSS.name);
      return text;
    });

    // Where it stands, on both axes. A page states every fact, so the ordinary
    // lifecycle is written out here rather than left to be inferred from the
    // moves being offered.
    expect(shown).toContain(MOSS.lifecycle);
    expect(shown).toContain(MOSS.connectivity);
    // A machine that is not connected carries how long ago its page was true.
    expect(shown).toMatch(/last seen/i);
    expect(shown).toContain(formatStamp(new Date(MOSS.lastSeenAt!), ZONE)!);

    // What it probed about itself.
    expect(shown).toContain(MOSS.facts!.os);
    expect(shown).toContain(MOSS.facts!.arch);
    expect(shown).toContain("2.50.1");
    expect(showsSize(shown, MOSS.facts!.totalMemoryBytes), `memory in: ${shown}`).toBe(true);

    expect(nameField().value).toBe(MOSS.name);
    expect(ticked(reservedField())).toBe(false);
    expect(screen.getByLabelText<HTMLInputElement>(/session/i).value).toBe(
      String(MOSS.maxConcurrentSessions),
    );
  });

  it("says a machine is the owner's own when it is", async () => {
    await open({ ...MOSS, reserved: true });

    await waitFor(() => {
      expect(ticked(reservedField())).toBe(true);
    });
  });
});

describe("Runner > saving", () => {
  /** A controller that answers a patch with the machine the patch makes. */
  const applyPatch = (runner: Fixture) => (call: Call) => ({
    body: { ...runner, ...(call.body as Record<string, unknown>) },
  });

  it("sends the fields the owner changed and nothing else, and says it landed", async () => {
    const user = userEvent.setup();
    const { api } = await open(MOSS, {
      extra: { [`PATCH /api/v1/runners/${MOSS.id}`]: applyPatch(MOSS) },
    });

    await waitFor(() => {
      expect(nameField().value).toBe(MOSS.name);
    });
    // Nothing has been touched, so there is no patch to send and Save says so.
    expect(action(/^save$/i).hasAttribute("disabled")).toBe(true);

    await user.clear(nameField());
    await user.type(nameField(), "moss-2");
    await user.click(action(/^save$/i));

    expect((await screen.findByRole("status")).textContent).toMatch(/saved/i);
    expect(writesTo(api, MOSS.id)).toHaveLength(1);
    expect(writesTo(api, MOSS.id)[0]?.body).toEqual({ name: "moss-2" });

    // The name is now what was saved, so the next write carries only the tick.
    await user.click(reservedField());
    await user.click(action(/^save$/i));

    await waitFor(() => {
      expect(writesTo(api, MOSS.id)).toHaveLength(2);
    });
    expect(writesTo(api, MOSS.id)[1]?.body).toEqual({ reserved: true });
  });

  it("puts a refused name beside the name", async () => {
    const user = userEvent.setup();
    const complaint = "another runner is already called hetzner-01";
    const { api } = await open(MOSS, {
      extra: {
        [`PATCH /api/v1/runners/${MOSS.id}`]: {
          status: 409,
          body: envelope("conflict", complaint),
        },
      },
    });

    await waitFor(() => {
      expect(nameField().value).toBe(MOSS.name);
    });
    await user.clear(nameField());
    await user.type(nameField(), "hetzner-01");
    await user.click(action(/^save$/i));

    const shown = await screen.findByText(new RegExp(complaint));
    const group = around(shown, nameField());
    expect(group.contains(nameField())).toBe(true);
    expect(group.contains(reservedField())).toBe(false);
    expect(writesTo(api, MOSS.id)).toHaveLength(1);
  });

  it("puts a refused reserved beside the tick", async () => {
    const user = userEvent.setup();
    const complaint = "the default runner cannot be reserved";
    await open(MOSS, {
      defaultRunnerId: MOSS.id,
      extra: {
        [`PATCH /api/v1/runners/${MOSS.id}`]: {
          status: 409,
          body: envelope("conflict", complaint),
        },
      },
    });

    await waitFor(() => {
      expect(ticked(reservedField())).toBe(false);
    });
    await user.click(reservedField());
    await user.click(action(/^save$/i));

    const shown = await screen.findByText(new RegExp(complaint));
    const group = around(shown, reservedField());
    expect(group.contains(reservedField())).toBe(true);
    expect(group.contains(nameField())).toBe(false);
  });
});

describe("Runner > moves", () => {
  it("drains the machine and shows that it is draining", async () => {
    const user = userEvent.setup();
    const draining: Fixture = { ...ONLINE, lifecycle: "draining" };
    const { api } = await open(ONLINE, {
      extra: { [`POST /api/v1/runners/${ONLINE.id}/drain`]: { body: draining } },
    });

    await user.click(await screen.findByRole("button", { name: /^drain$/i }));

    await waitFor(() => {
      expect(reading()).toContain("draining");
    });
    expect(writesTo(api, ONLINE.id).map((call) => call.path)).toEqual([
      `/api/v1/runners/${ONLINE.id}/drain`,
    ]);
  });

  it("calls a drain off again", async () => {
    const user = userEvent.setup();
    const draining: Fixture = { ...ONLINE, lifecycle: "draining" };
    const { api } = await open(draining, {
      extra: { [`POST /api/v1/runners/${draining.id}/undrain`]: { body: ONLINE } },
    });

    await user.click(await screen.findByRole("button", { name: /^undrain$/i }));

    await waitFor(() => {
      expect(reading()).not.toContain("draining");
    });
    expect(writesTo(api, draining.id).map((call) => call.path)).toEqual([
      `/api/v1/runners/${draining.id}/undrain`,
    ]);
  });

  it("asks the machine to probe itself again and shows what came back", async () => {
    const user = userEvent.setup();
    const probed: Fixture = {
      ...ONLINE,
      facts: { ...ONLINE.facts!, totalMemoryBytes: 32 * GIB, arch: "x64" },
    };
    const { api } = await open(ONLINE, {
      extra: { [`POST /api/v1/runners/${ONLINE.id}/refresh-facts`]: { body: probed } },
    });

    await user.click(await screen.findByRole("button", { name: /refresh facts/i }));

    await waitFor(() => {
      expect(reading()).toContain("x64");
    });
    expect(showsSize(reading(), 32 * GIB), `the new memory in: ${reading()}`).toBe(true);
    expect(writesTo(api, ONLINE.id).map((call) => call.path)).toEqual([
      `/api/v1/runners/${ONLINE.id}/refresh-facts`,
    ]);
  });

  it("does not send a field the owner never touched after a move changed it", async () => {
    // The derived session cap follows the machine's memory, so a re-probe moves
    // it under the form. Saving must never send that number back: the
    // controller would store it as an override, and there is no control
    // anywhere that undoes one.
    const user = userEvent.setup();
    const probed: Fixture = {
      ...ONLINE,
      facts: { ...ONLINE.facts!, totalMemoryBytes: 8 * GIB },
      maxConcurrentSessions: 4,
    };
    const { api } = await open(ONLINE, {
      // The answer to a patch is the machine as it now stands, cap included.
      extra: {
        [`POST /api/v1/runners/${ONLINE.id}/refresh-facts`]: { body: probed },
        [`PATCH /api/v1/runners/${ONLINE.id}`]: (call: Call) => ({
          body: { ...probed, ...(call.body as Record<string, unknown>) },
        }),
      },
    });

    await waitFor(() => {
      expect(nameField().value).toBe(ONLINE.name);
    });
    await user.clear(nameField());
    await user.type(nameField(), "moss-2");

    await user.click(await screen.findByRole("button", { name: /refresh facts/i }));

    // The re-probe changed the cap, but a half-typed form is not overwritten,
    // so the field still holds what the reader is working from.
    await waitFor(() => {
      expect(reading()).toContain("8 GiB");
    });
    expect(nameField().value).toBe("moss-2");

    await user.click(action(/^save$/i));
    await screen.findByRole("status");

    // Only the name. The cap the re-probe moved is not the user's to send.
    const first = writesTo(api, ONLINE.id).filter((call) => call.method === "PATCH");
    expect(first).toHaveLength(1);
    expect(first[0]?.body).toEqual({ name: "moss-2" });

    // The save answered with the machine whole, so the form now shows the cap
    // the re-probe derived rather than the one it opened with.
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>(/session/i).value).toBe("4");
    });

    // The answer to the save above is what the next patch is measured against,
    // whole, so nothing is left to send and Save is no longer offered.
    expect(action(/^save$/i).hasAttribute("disabled")).toBe(true);
    await user.click(action(/^save$/i));
    expect(writesTo(api, ONLINE.id).filter((call) => call.method === "PATCH")).toHaveLength(1);
  });

  it("says what a refused move was refused with", async () => {
    const user = userEvent.setup();
    const complaint = "the runner did not answer within 10s";
    const { api } = await open(ONLINE, {
      extra: {
        [`POST /api/v1/runners/${ONLINE.id}/refresh-facts`]: {
          status: 409,
          body: envelope("invalid_state", complaint),
        },
      },
    });

    await user.click(await screen.findByRole("button", { name: /refresh facts/i }));

    expect((await screen.findByRole("alert")).textContent).toContain(complaint);
    expect(writesTo(api, ONLINE.id)).toHaveLength(1);
  });

  it("drops what a refused move said once another move succeeds", async () => {
    const user = userEvent.setup();
    const complaint = "the runner did not answer within 10s";
    await open(ONLINE, {
      extra: {
        [`POST /api/v1/runners/${ONLINE.id}/refresh-facts`]: {
          status: 409,
          body: envelope("invalid_state", complaint),
        },
        [`POST /api/v1/runners/${ONLINE.id}/drain`]: {
          body: { ...ONLINE, lifecycle: "draining" },
        },
      },
    });

    await user.click(await screen.findByRole("button", { name: /refresh facts/i }));
    expect((await screen.findByRole("alert")).textContent).toContain(complaint);

    await user.click(action(/^drain$/i));

    // The drain worked, so the refusal above it is not this page's state any
    // more; leaving it there reads as the drain having failed.
    await waitFor(() => {
      expect(reading()).toContain("draining");
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(reading()).not.toContain(complaint);
  });
});

describe("Runner > retiring", () => {
  const retired = (runner: Fixture): Fixture => ({ ...runner, lifecycle: "retired" });

  it("asks before it retires, and sends nothing until the question is answered", async () => {
    const user = userEvent.setup();
    const { api } = await open(ONLINE, {
      extra: { [`POST /api/v1/runners/${ONLINE.id}/retire`]: { body: retired(ONLINE) } },
    });

    await user.click(await screen.findByRole("button", { name: /^retire$/i }));
    expect(writesTo(api, ONLINE.id)).toEqual([]);

    // Backing out leaves the machine as it was.
    await user.click(action(/^cancel$/i));
    expect(writesTo(api, ONLINE.id)).toEqual([]);
    expect(reading()).not.toContain("retired");

    await user.click(await screen.findByRole("button", { name: /^retire$/i }));
    await user.click(action(/^confirm$/i));

    await waitFor(() => {
      expect(reading()).toContain("retired");
    });
    const sent = writesTo(api, ONLINE.id);
    expect(sent.map((call) => call.path)).toEqual([`/api/v1/runners/${ONLINE.id}/retire`]);
    // A machine the controller can account for is not forced.
    expect((sent[0]?.body as { force?: boolean } | undefined)?.force).not.toBe(true);
  });

  it("says that retiring a machine it cannot reach forces it, and forces it", async () => {
    const user = userEvent.setup();
    const { api } = await open(LOST, {
      extra: { [`POST /api/v1/runners/${LOST.id}/retire`]: { body: retired(LOST) } },
    });

    await user.click(await screen.findByRole("button", { name: /^retire$/i }));

    expect(reading()).toContain("This runner is unreachable; retiring it now forces it");

    await user.click(action(/^confirm$/i));

    await waitFor(() => {
      expect(writesTo(api, LOST.id)).toHaveLength(1);
    });
    expect(writesTo(api, LOST.id)[0]?.body).toEqual({ force: true });
  });

  // The default-runner sentence and the case where neither sentence applies are
  // pinned exactly, and in every combination, by retireQuestion's unit test. Only
  // the unreachable case is driven through the browser, because it is the one
  // that also has to prove `force: true` reaches the wire.

  it("offers nothing to do to a machine that has been retired", async () => {
    await open(retired(MOSS));

    await waitFor(() => {
      expect(reading()).toContain("retired");
    });
    const page = within(document.body);
    for (const move of [/^drain$/i, /^undrain$/i, /^retire$/i, /refresh facts/i]) {
      expect(page.queryByRole("button", { name: move }), `${String(move)} is offered`).toBeNull();
    }
  });
});
