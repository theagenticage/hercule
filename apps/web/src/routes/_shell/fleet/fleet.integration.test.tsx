/**
 * The Fleet screen: what a machine's row says, which machine the browser is
 * sitting on, and how a new machine is enlisted, over a stubbed controller.
 *
 * The fleet is the one screen whose rows are almost entirely a machine's own
 * report, so the assertions here are about what a runner said reaching the
 * reader: the state it is in, the binary it runs, and the facts it probed. A
 * row that shows a name and nothing else would leave a person no way to tell
 * two machines apart.
 *
 * Which row is "this machine" cannot be asked of the controller - it knows
 * every runner and where none of them are - so detection is handed to the app
 * and stubbed here, and both of its answers are held: the id of a listed
 * runner, and nothing at all.
 */
import { describe, expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp, stubApi, type Call, type Handler } from "../../../app/testing";

/** The version this controller answers `controller.read` with. */
const CONTROLLER_VERSION = "0.4.2";

interface Fixture {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly version: string | null;
  readonly labels: readonly string[];
  readonly facts: {
    readonly os: string;
    readonly arch: string;
    readonly totalMemoryBytes: number;
    readonly docker: boolean;
    readonly toolchains: readonly { name: string; version: string; path: string }[];
    readonly providers: readonly { name: string; present: boolean }[];
    readonly identityPort: number;
  } | null;
  readonly watermark: {
    readonly diskFreeBytes: number;
    readonly availableMemoryBytes: number;
    readonly acceptingPlacements: boolean;
  } | null;
  readonly maxConcurrentSessions: number;
  readonly lastSeenAt: string | null;
}

const GIB = 1024 * 1024 * 1024;

/** The machine the browser is on: current, labelled, and reporting everything. */
const MOSS: Fixture = {
  id: "01a06d02-beff-7037-9f5b-042822015952",
  name: "moss",
  state: "online",
  version: CONTROLLER_VERSION,
  labels: ["gpu", "primary"],
  facts: {
    os: "darwin",
    arch: "arm64",
    totalMemoryBytes: 64 * GIB,
    docker: true,
    toolchains: [
      { name: "git", version: "2.50.1", path: "/usr/bin/git" },
      { name: "gh", version: "2.99.0", path: "/opt/homebrew/bin/gh" },
    ],
    providers: [{ name: "claude", present: true }],
    identityPort: 4939,
  },
  watermark: {
    diskFreeBytes: 128 * GIB,
    availableMemoryBytes: 32 * GIB,
    acceptingPlacements: true,
  },
  maxConcurrentSessions: 4,
  lastSeenAt: "2026-09-05T09:14:00.000Z",
};

/** A machine somewhere else, running an older binary than the controller. */
const HETZNER: Fixture = {
  id: "01a06d02-c111-7a0e-8b3d-9c1f7c82ebeb",
  name: "hetzner-01",
  state: "unreachable",
  version: "0.3.9",
  labels: ["linux"],
  facts: {
    os: "linux",
    arch: "x64",
    totalMemoryBytes: 16 * GIB,
    docker: false,
    toolchains: [{ name: "git", version: "2.43.0", path: "/usr/bin/git" }],
    providers: [],
    identityPort: 5000,
  },
  watermark: { diskFreeBytes: 42 * GIB, availableMemoryBytes: 4 * GIB, acceptingPlacements: false },
  maxConcurrentSessions: 2,
  lastSeenAt: "2026-09-05T08:02:00.000Z",
};

const TOKEN = "jt_a-token-nobody-else-holds";

/** A controller holding the fleet given, and answering for itself. */
const controller = (
  runners: readonly Fixture[],
  extra: Readonly<Record<string, Handler>> = {},
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: {
      controller: {},
      user: { "onboarding.completedSteps": ["timezone"], timezone: "Europe/Amsterdam" },
    },
  },
  "GET /api/v1/controller": {
    body: {
      id: "01a06d02-a000-7000-8000-000000000001",
      publicKey: "bm90LWEta2V5",
      version: CONTROLLER_VERSION,
      defaultRunnerId: null,
    },
  },
  "GET /api/v1/runners": { body: { items: runners } },
  "POST /api/v1/runners/join-tokens": {
    status: 201,
    body: { token: TOKEN, expiresAt: "2026-09-05T10:14:00.000Z" },
  },
  ...extra,
});

const open = async (
  runners: readonly Fixture[],
  options: {
    readonly extra?: Readonly<Record<string, Handler>>;
    readonly local?: string | null;
  } = {},
) => {
  const api = stubApi(controller(runners, options.extra));
  const app = await renderApp({
    path: "/fleet",
    api: api.fetch,
    token: "held",
    detectLocalRunner: () => Promise.resolve(options.local ?? null),
  });
  return { ...app, api };
};

/** The fleet listings the screen made, oldest first. */
const listings = (api: { readonly calls: readonly Call[] }) =>
  api.calls.filter((call) => call.method === "GET" && call.path === "/api/v1/runners");

/** The page's text with its whitespace collapsed, the way a reader sees it. */
const reading = (element: HTMLElement | null = document.body): string =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();

/**
 * The part of the page that is about one machine and no other.
 *
 * A row has no shape this test is entitled to know, so it is found rather than
 * assumed: start at the deepest element carrying the name and climb while the
 * parent still says nothing about any other machine. What comes back is
 * everything the screen says about that one runner, whatever it is built from.
 */
const rowFor = async (name: string, others: readonly string[]): Promise<HTMLElement> => {
  const found = await screen.findAllByText(new RegExp(name));
  let row = found.reduce((left, right) =>
    (left.textContent ?? "").length <= (right.textContent ?? "").length ? left : right,
  );
  while (
    row.parentElement !== null &&
    !others.some((other) => (row.parentElement?.textContent ?? "").includes(other))
  ) {
    row = row.parentElement;
  }
  return row;
};

/**
 * Whether a size is on screen. Which unit a byte count is written in is the
 * screen's business, so both readings of it count - what this asserts is that
 * the number reached the reader at all, not how it was rounded.
 */
const showsSize = (text: string, bytes: number): boolean => {
  const binary = bytes / 1024 ** 3;
  const decimal = bytes / 1000 ** 3;
  const shapes = [binary.toFixed(0), decimal.toFixed(0), decimal.toFixed(1)];
  return shapes.some((shape) => new RegExp(`(^|[^\\d.])${shape}\\s?G`, "i").test(text));
};

describe("Fleet", () => {
  it("shows what each machine is and what it reported about itself", async () => {
    await open([MOSS, HETZNER]);

    const moss = reading(await rowFor(MOSS.name, [HETZNER.name]));
    expect(moss).toContain("online");
    expect(moss).toContain(CONTROLLER_VERSION);
    expect(moss).toContain("gpu");
    expect(moss).toContain("primary");
    expect(moss).toContain("darwin");
    expect(moss).toContain("arm64");
    expect(moss).toContain("2.50.1");
    expect(moss).toContain("2.99.0");
    expect(showsSize(moss, MOSS.facts!.totalMemoryBytes), `memory in: ${moss}`).toBe(true);
    expect(showsSize(moss, MOSS.watermark!.diskFreeBytes), `free disk in: ${moss}`).toBe(true);

    const hetzner = reading(await rowFor(HETZNER.name, [MOSS.name]));
    expect(hetzner).toContain("unreachable");
    expect(hetzner).toContain("linux");
    expect(hetzner).toContain("x64");
    expect(hetzner).toContain("2.43.0");
    expect(showsSize(hetzner, HETZNER.facts!.totalMemoryBytes), `memory in: ${hetzner}`).toBe(true);
    expect(showsSize(hetzner, HETZNER.watermark!.diskFreeBytes), `free disk in: ${hetzner}`).toBe(
      true,
    );
  });

  it("warns on the machine whose binary is not the controller's, and only there", async () => {
    await open([MOSS, HETZNER]);

    // The wording is the screen's; what has to be there is that the row says
    // its binary is not the controller's, rather than only printing a number
    // the reader would have to compare themselves.
    const skew = /skew|mismatch|differ|out of date|behind|ahead|older|newer|not the controller/i;
    const hetzner = reading(await rowFor(HETZNER.name, [MOSS.name]));
    expect(hetzner).toContain(HETZNER.version);
    expect(hetzner, "the older binary is called out").toMatch(skew);

    // The machine on the controller's own version says nothing about skew.
    const moss = reading(await rowFor(MOSS.name, [HETZNER.name]));
    expect(moss).not.toMatch(skew);
  });

  it("keeps its shape when no machine has joined", async () => {
    await open([]);

    expect(reading()).toContain("no runner has joined yet");
    expect(reading()).toContain(
      "A runner probes the machine it runs on and reports what it found. Until one joins, Hydra knows nothing about this machine.",
    );
    expect(screen.getByText("Add machine")).toBeTruthy();
  });
});

describe("Fleet > this machine", () => {
  it("marks the machine the browser is on, and only that one", async () => {
    await open([MOSS, HETZNER], { local: MOSS.id });

    await waitFor(async () => {
      expect(reading(await rowFor(MOSS.name, [HETZNER.name]))).toContain("this machine");
    });
    expect(reading(await rowFor(HETZNER.name, [MOSS.name]))).not.toContain("this machine");
  });

  it("marks nothing when no machine on this browser answers", async () => {
    await open([MOSS, HETZNER], { local: null });

    await screen.findAllByText(new RegExp(MOSS.name));
    // Detection resolves on its own turn, so the absence is given the time a
    // present sub-label would have taken to arrive.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reading()).not.toContain("this machine");
  });
});

describe("Fleet > add machine", () => {
  it("mints a token and shows the command that spends it", async () => {
    const user = userEvent.setup();
    const { api } = await open([MOSS]);

    // The spot may already be open; what matters is the token and the command.
    const spot = screen.queryByRole("button", { name: /add machine/i });
    if (spot !== null) await user.click(spot);

    await waitFor(() => {
      expect(reading()).toContain(`hydra runner join ${window.location.origin} --token ${TOKEN}`);
    });
    expect(
      api.calls.filter(
        (call) => call.method === "POST" && call.path === "/api/v1/runners/join-tokens",
      ).length,
    ).toBeGreaterThan(0);
    // The command that predates the join exchange is not what is shown.
    expect(reading()).not.toContain("hydra runner --controller");
  });
});

describe("Fleet > live", () => {
  /** One invalidation, in the shape the contract puts on the wire. */
  const invalidate = (kind: string, ids: readonly string[]) => ({ _tag: "invalidate", ids, kind });

  it("shows a machine's new state when it changes elsewhere", async () => {
    // A second machine, so what the changed row says is read off that row and
    // not off a page that has the word on it somewhere.
    const OTHER: Fixture = { ...HETZNER, state: "offline" };
    let held: readonly Fixture[] = [MOSS, OTHER];
    const { api, live } = await open(held, {
      extra: { "GET /api/v1/runners": () => ({ body: { items: held } }) },
    });

    expect(reading(await rowFor(MOSS.name, [OTHER.name]))).toContain("online");
    await waitFor(() => {
      expect(live.topics()).toContain("runner");
    });
    const before = listings(api).length;

    held = [{ ...MOSS, state: "unreachable" }, OTHER];
    act(() => {
      live.push("runner", invalidate("updated", [MOSS.id]));
    });

    await waitFor(async () => {
      expect(reading(await rowFor(MOSS.name, [OTHER.name]))).toContain("unreachable");
    });
    // The row came from a fresh listing, not from the push itself.
    expect(listings(api).length).toBeGreaterThan(before);
  });
});
