/**
 * The Fleet screen: what a machine's row says, which machine the browser is
 * sitting on, and how a new machine is enlisted, over a stubbed controller.
 *
 * The fleet is the one screen whose rows are almost entirely a machine's own
 * report, so the assertions here are about what a runner said reaching the
 * reader: whether it is reachable, the binary it runs, and the facts it probed. A
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
import { formatStamp } from "@hydra/client-core";
import { reading, renderApp, stubApi, type Call, type Handler } from "../../../app/testing";
import { CONTROLLER_VERSION, GIB, MOSS, ZONE, type Fixture } from "./-fixtures";

/** A machine somewhere else, running an older binary than the controller. */
const HETZNER: Fixture = {
  ...MOSS,
  id: "01a06d02-c111-7a0e-8b3d-9c1f7c82ebeb",
  name: "hetzner-01",
  connectivity: "unreachable",
  version: "0.3.9",
  labels: ["linux"],
  facts: {
    os: "linux",
    arch: "x64",
    totalMemoryBytes: 16 * GIB,
    docker: false,
    toolchains: [{ name: "git", version: "2.43.0", path: "/usr/bin/git" }],
    providers: [],
    adapters: ["claude-code"],
    identityPort: 5000,
  },
  watermark: { diskFreeBytes: 42 * GIB, availableMemoryBytes: 4 * GIB },
  maxConcurrentSessions: 2,
  lastSeenAt: "2026-09-05T08:02:00.000Z",
};

/** A machine the owner is emptying: reachable, but on its way out of the fleet. */
const SIRIUS: Fixture = {
  ...HETZNER,
  id: "01a06d02-d222-7b1f-9c4e-ad2e6b39f0aa",
  name: "sirius",
  connectivity: "online",
  lifecycle: "draining",
  version: CONTROLLER_VERSION,
  labels: [],
};

const TOKEN = "jt_a-token-nobody-else-holds";

interface TokenFixture {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** A token minted a moment ago, running out in `minutes`. */
const outstanding = (id: string, minutes: number): TokenFixture => ({
  id,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
});

const EXPIRING_SOON = outstanding("01a06d02-e100-7c00-8a00-000000000001", 12);
const EXPIRING_LATER = outstanding("01a06d02-e100-7c00-8a00-000000000002", 55);

/** A controller holding the fleet given, and answering for itself. */
const controller = (
  runners: readonly Fixture[],
  extra: Readonly<Record<string, Handler>> = {},
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
      defaultRunnerId: null,
    },
  },
  "GET /api/v1/runners": { body: { items: runners } },
  "POST /api/v1/runners/join-tokens": {
    status: 201,
    body: { token: TOKEN, expiresAt: "2026-09-05T10:14:00.000Z" },
  },
  // Nothing is outstanding unless a test says so; the screen asks either way.
  "GET /api/v1/runners/join-tokens": { body: [] },
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
 * Whether a size is on screen, as the whole number of gibibytes the fixtures
 * are all round multiples of. Anything else the screen might have printed is
 * something a reader would have to convert in their head.
 */
const showsSize = (text: string, bytes: number): boolean =>
  new RegExp(`(^|[^\\d.])${(bytes / 1024 ** 3).toFixed(0)} ?GiB`).test(text);

/**
 * Whether a token's expiry reached the reader.
 *
 * When a token runs out is a stamp, read in the user's own zone the way every
 * other moment on this screen is. A countdown would be a second reading of time
 * in one app, which is the decision this pins.
 */
const showsExpiry = (text: string, token: TokenFixture): boolean => {
  const stamp = formatStamp(new Date(token.expiresAt), ZONE);
  return stamp !== undefined && text.includes(stamp);
};

const revokes = (): readonly HTMLElement[] => screen.queryAllByRole("button", { name: /revoke/i });

/** The link a row carries, whether it wraps the row or sits inside it. */
const linkIn = (row: HTMLElement): HTMLAnchorElement | null =>
  row.closest("a") ?? row.querySelector("a");

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

    await user.click(screen.getByRole("button", { name: /add machine/i }));

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

  it("shows that a machine has become unreachable when it does so elsewhere", async () => {
    // A second machine, so what the changed row says is read off that row and
    // not off a page that has the word on it somewhere.
    const OTHER: Fixture = { ...HETZNER, connectivity: "offline" };
    let held: readonly Fixture[] = [MOSS, OTHER];
    const { api, live } = await open(held, {
      extra: { "GET /api/v1/runners": () => ({ body: { items: held } }) },
    });

    expect(reading(await rowFor(MOSS.name, [OTHER.name]))).toContain("online");
    await waitFor(() => {
      expect(live.topics()).toContain("runner");
    });
    const before = listings(api).length;

    held = [{ ...MOSS, connectivity: "unreachable" }, OTHER];
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

describe("Fleet > outstanding tokens", () => {
  it("lists the tokens still waiting to be spent, and when each runs out", async () => {
    await open([MOSS], {
      extra: { "GET /api/v1/runners/join-tokens": { body: [EXPIRING_SOON, EXPIRING_LATER] } },
    });

    await waitFor(() => {
      expect(revokes()).toHaveLength(2);
    });
    const shown = reading();
    expect(showsExpiry(shown, EXPIRING_SOON), `the first expiry in: ${shown}`).toBe(true);
    expect(showsExpiry(shown, EXPIRING_LATER), `the second expiry in: ${shown}`).toBe(true);
  });

  it("offers nothing to take back when no token is outstanding", async () => {
    await open([MOSS]);

    await screen.findByRole("button", { name: /add machine/i });
    expect(revokes()).toEqual([]);
  });

  it("takes a token back, and drops it from the list", async () => {
    const user = userEvent.setup();
    let held: readonly TokenFixture[] = [EXPIRING_SOON, EXPIRING_LATER];
    const { api } = await open([MOSS], {
      extra: {
        "GET /api/v1/runners/join-tokens": () => ({ body: held }),
        [`DELETE /api/v1/runners/join-tokens/${EXPIRING_SOON.id}`]: () => {
          held = held.filter((token) => token.id !== EXPIRING_SOON.id);
          return { body: {} };
        },
        [`DELETE /api/v1/runners/join-tokens/${EXPIRING_LATER.id}`]: () => {
          held = held.filter((token) => token.id !== EXPIRING_LATER.id);
          return { body: {} };
        },
      },
    });

    await waitFor(() => {
      expect(revokes()).toHaveLength(2);
    });
    const first = revokes()[0];
    expect(first).toBeDefined();
    await user.click(first!);

    // Which token that button was for is read off the request rather than
    // guessed from the order the list happens to be in.
    const deletes = api.calls.filter(
      (call) => call.method === "DELETE" && call.path.startsWith("/api/v1/runners/join-tokens/"),
    );
    expect(deletes).toHaveLength(1);
    const revoked = [EXPIRING_SOON, EXPIRING_LATER].find(
      (token) => deletes[0]?.path === `/api/v1/runners/join-tokens/${token.id}`,
    );
    expect(
      revoked,
      `the revoke named a listed token, not ${String(deletes[0]?.path)}`,
    ).toBeDefined();
    const survivor = revoked === EXPIRING_SOON ? EXPIRING_LATER : EXPIRING_SOON;

    await waitFor(() => {
      expect(revokes()).toHaveLength(1);
    });
    expect(showsExpiry(reading(), survivor)).toBe(true);
    expect(showsExpiry(reading(), revoked!)).toBe(false);
  });
});

describe("Fleet > add machine > personal", () => {
  it("puts the reserved flag on the command the machine will run", async () => {
    const user = userEvent.setup();
    await open([MOSS]);

    await user.click(screen.getByRole("button", { name: /add machine/i }));
    const plain = `hydra runner join ${window.location.origin} --token ${TOKEN}`;
    await waitFor(() => {
      expect(reading()).toContain(plain);
    });
    expect(reading()).not.toContain("--reserved");

    await user.click(screen.getByRole("checkbox", { name: /personal machine/i }));

    await waitFor(() => {
      expect(reading()).toContain(`${plain} --reserved`);
    });

    // The flag is the tick's, so unticking takes it back off.
    await user.click(screen.getByRole("checkbox", { name: /personal machine/i }));
    await waitFor(() => {
      expect(reading()).not.toContain("--reserved");
    });
    expect(reading()).toContain(plain);
  });
});

describe("Fleet > opening a machine", () => {
  it("says where each machine stands and leads to the machine itself", async () => {
    await open([MOSS, SIRIUS]);

    const moss = await rowFor(MOSS.name, [SIRIUS.name]);
    expect(reading(moss)).toContain(MOSS.connectivity);
    expect(linkIn(moss)?.getAttribute("href")).toBe(`/fleet/${MOSS.id}`);

    // A machine on its way out says so: its lifecycle is the reason a reader
    // would open it, and it is not what its connectivity says.
    const sirius = await rowFor(SIRIUS.name, [MOSS.name]);
    expect(reading(sirius)).toContain(SIRIUS.connectivity);
    expect(reading(sirius)).toContain(SIRIUS.lifecycle);
    expect(linkIn(sirius)?.getAttribute("href")).toBe(`/fleet/${SIRIUS.id}`);
  });
});
