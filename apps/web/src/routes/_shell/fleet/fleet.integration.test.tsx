/**
 * Tests for the Fleet screen, against a stubbed controller: what a runner's
 * row shows, which runner is on the browser's machine, and how a new machine
 * is added.
 *
 * The fleet rows show almost only what each runner reported about itself, so
 * these tests check that the report reaches the screen: whether the runner is
 * reachable, the binary version it runs, and the facts it probed. A row that
 * showed only a name would give a person no way to tell two machines apart.
 *
 * The controller cannot tell which runner is "this machine", because it does
 * not know where the browser is. The app detects it instead, and the tests stub
 * that detection with both possible results: the id of a listed runner, and
 * null.
 */
import { describe, expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { formatStamp } from "@hercule/client-core";
import { readPageText, renderApp, stubApi, type Call, type Handler } from "../../../app/testing";
import { CONTROLLER_VERSION, GIB, MOSS, ZONE, type Fixture } from "./-fixtures";

/** A remote runner, running an older binary than the controller. */
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

/** A runner the owner is draining: online, but leaving the fleet. */
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

/** Builds a join token created a minute ago that expires in `minutes`. */
const buildOutstandingToken = (id: string, minutes: number): TokenFixture => ({
  id,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
});

const EXPIRING_SOON = buildOutstandingToken("01a06d02-e100-7c00-8a00-000000000001", 12);
const EXPIRING_LATER = buildOutstandingToken("01a06d02-e100-7c00-8a00-000000000002", 55);

/** Builds a stub controller that returns `runners` and its own record. */
const buildController = (
  runners: readonly Fixture[],
  extra: Readonly<Record<string, Handler>> = {},
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: {
      controller: {},
      user: { "onboarding.completedSteps": ["timezone", "assistant"], timezone: ZONE },
    },
  },
  "GET /api/v1/controller": {
    body: {
      id: "01a06d02-a000-7000-8000-000000000001",
      publicKey: "bm90LWEta2V5",
      version: CONTROLLER_VERSION,
      defaultRunnerId: null,
      localRunnerId: null,
    },
  },
  "GET /api/v1/runners": { body: { items: runners } },
  "POST /api/v1/runners/join-tokens": {
    status: 201,
    body: { token: TOKEN, expiresAt: "2026-09-05T10:14:00.000Z" },
  },
  // No unused tokens unless a test adds some; the screen fetches them either way.
  "GET /api/v1/runners/join-tokens": { body: [] },
  ...extra,
});

const openApp = async (
  runners: readonly Fixture[],
  options: {
    readonly extra?: Readonly<Record<string, Handler>>;
    readonly local?: string | null;
  } = {},
) => {
  const api = stubApi(buildController(runners, options.extra));
  const app = await renderApp({
    path: "/fleet",
    api: api.fetch,
    token: "held",
    detectLocalRunner: () => Promise.resolve(options.local ?? null),
  });
  return { ...app, api };
};

/** Returns the runner list requests the screen made, oldest first. */
const listRunnerReads = (api: { readonly calls: readonly Call[] }) =>
  api.calls.filter((call) => call.method === "GET" && call.path === "/api/v1/runners");

/**
 * Finds the part of the page about the runner `name` and no runner in `others`.
 *
 * The test should not depend on how a row is built, so the row is searched
 * for: start at the smallest element that contains the name, and climb while
 * the parent's text mentions none of `others`. The result holds everything the
 * screen shows about that one runner, whatever elements it is built from.
 */
const findRunnerRow = async (name: string, others: readonly string[]): Promise<HTMLElement> => {
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
 * Checks whether `text` shows `bytes` as a whole number of GiB. The fixtures
 * are all whole GiB, and any other unit would make the reader convert it in
 * their head.
 */
const showsSize = (text: string, bytes: number): boolean =>
  new RegExp(`(^|[^\\d.])${(bytes / 1024 ** 3).toFixed(0)} ?GiB`).test(text);

/**
 * Checks whether `text` shows the token's expiry.
 *
 * The expiry is shown as a timestamp in the user's own timezone, like every
 * other time on this screen. This check pins that decision: a countdown would
 * be a second way to show time in the same app.
 */
const showsExpiry = (text: string, token: TokenFixture): boolean => {
  const stamp = formatStamp(new Date(token.expiresAt), ZONE);
  return stamp !== undefined && text.includes(stamp);
};

const queryRevokeButtons = (): readonly HTMLElement[] =>
  screen.queryAllByRole("button", { name: /revoke/i });

/** Returns the row's link, whether the link wraps the row or sits inside it. */
const findRowLink = (row: HTMLElement): HTMLAnchorElement | null =>
  row.closest("a") ?? row.querySelector("a");

describe("Fleet", () => {
  it("shows each runner's name and what it reported about itself", async () => {
    await openApp([MOSS, HETZNER]);

    const moss = readPageText(await findRunnerRow(MOSS.name, [HETZNER.name]));
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

    const hetzner = readPageText(await findRunnerRow(HETZNER.name, [MOSS.name]));
    expect(hetzner).toContain("unreachable");
    expect(hetzner).toContain("linux");
    expect(hetzner).toContain("x64");
    expect(hetzner).toContain("2.43.0");
    expect(showsSize(hetzner, HETZNER.facts!.totalMemoryBytes), `memory in: ${hetzner}`).toBe(true);
    expect(showsSize(hetzner, HETZNER.watermark!.diskFreeBytes), `free disk in: ${hetzner}`).toBe(
      true,
    );
  });

  it("warns on the runner whose binary version differs from the controller's, and only there", async () => {
    await openApp([MOSS, HETZNER]);

    // The exact wording is up to the screen. What matters is that the row
    // says its version differs from the controller's, rather than only
    // showing a number the reader has to compare.
    const skew = /skew|mismatch|differ|out of date|behind|ahead|older|newer|not the controller/i;
    const hetzner = readPageText(await findRunnerRow(HETZNER.name, [MOSS.name]));
    expect(hetzner).toContain(HETZNER.version);
    expect(hetzner, "the older binary is called out").toMatch(skew);

    // The runner on the controller's version shows no warning.
    const moss = readPageText(await findRunnerRow(MOSS.name, [HETZNER.name]));
    expect(moss).not.toMatch(skew);
  });

  it("shows a placeholder row and the add card when no runner has joined", async () => {
    await openApp([]);

    expect(readPageText()).toContain("no runner has joined yet");
    expect(readPageText()).toContain(
      "A runner probes the machine it runs on and reports what it found. Until one joins, Hercule knows nothing about this machine.",
    );
    expect(screen.getByText("Add machine")).toBeTruthy();
  });
});

describe("Fleet > this machine", () => {
  it("marks the runner on the browser's machine, and only that one", async () => {
    await openApp([MOSS, HETZNER], { local: MOSS.id });

    await waitFor(async () => {
      expect(readPageText(await findRunnerRow(MOSS.name, [HETZNER.name]))).toContain(
        "this machine",
      );
    });
    expect(readPageText(await findRunnerRow(HETZNER.name, [MOSS.name]))).not.toContain(
      "this machine",
    );
  });

  it("marks nothing when no runner is detected on the browser's machine", async () => {
    await openApp([MOSS, HETZNER], { local: null });

    await screen.findAllByText(new RegExp(MOSS.name));
    // Detection resolves asynchronously, so wait as long as a found runner's
    // label would take to appear before checking that none did.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readPageText()).not.toContain("this machine");
  });
});

describe("Fleet > add machine", () => {
  it("creates a token and shows the join command that uses it", async () => {
    const user = userEvent.setup();
    const { api } = await openApp([MOSS]);

    await user.click(screen.getByRole("button", { name: /add machine/i }));

    await waitFor(() => {
      expect(readPageText()).toContain(
        `hercule runner join ${window.location.origin} --token ${TOKEN}`,
      );
    });
    expect(
      api.calls.filter(
        (call) => call.method === "POST" && call.path === "/api/v1/runners/join-tokens",
      ).length,
    ).toBeGreaterThan(0);
    // The old command from before join tokens existed is not shown.
    expect(readPageText()).not.toContain("hercule runner --controller");
  });
});

describe("Fleet > live", () => {
  /** Builds an invalidation message in its wire format. */
  const buildInvalidation = (kind: string, ids: readonly string[]) => ({
    _tag: "invalidate",
    ids,
    kind,
  });

  it("shows a runner as unreachable after a live update says it changed", async () => {
    // A second runner, so the check reads the changed row itself and not a
    // word that could appear anywhere on the page.
    const OTHER: Fixture = { ...HETZNER, connectivity: "offline" };
    let held: readonly Fixture[] = [MOSS, OTHER];
    const { api, live } = await openApp(held, {
      extra: { "GET /api/v1/runners": () => ({ body: { items: held } }) },
    });

    expect(readPageText(await findRunnerRow(MOSS.name, [OTHER.name]))).toContain("online");
    await waitFor(() => {
      expect(live.topics()).toContain("runner");
    });
    const before = listRunnerReads(api).length;

    held = [{ ...MOSS, connectivity: "unreachable" }, OTHER];
    act(() => {
      live.push("runner", buildInvalidation("updated", [MOSS.id]));
    });

    await waitFor(async () => {
      expect(readPageText(await findRunnerRow(MOSS.name, [OTHER.name]))).toContain("unreachable");
    });
    // The row comes from a refetched list, not from the pushed message.
    expect(listRunnerReads(api).length).toBeGreaterThan(before);
  });
});

describe("Fleet > outstanding tokens", () => {
  it("lists the unused tokens, and when each expires", async () => {
    await openApp([MOSS], {
      extra: { "GET /api/v1/runners/join-tokens": { body: [EXPIRING_SOON, EXPIRING_LATER] } },
    });

    await waitFor(() => {
      expect(queryRevokeButtons()).toHaveLength(2);
    });
    const shown = readPageText();
    expect(showsExpiry(shown, EXPIRING_SOON), `the first expiry in: ${shown}`).toBe(true);
    expect(showsExpiry(shown, EXPIRING_LATER), `the second expiry in: ${shown}`).toBe(true);
  });

  it("shows no Revoke button when there are no unused tokens", async () => {
    await openApp([MOSS]);

    await screen.findByRole("button", { name: /add machine/i });
    expect(queryRevokeButtons()).toEqual([]);
  });

  it("revokes a token and removes it from the list", async () => {
    const user = userEvent.setup();
    let held: readonly TokenFixture[] = [EXPIRING_SOON, EXPIRING_LATER];
    const { api } = await openApp([MOSS], {
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
      expect(queryRevokeButtons()).toHaveLength(2);
    });
    const first = queryRevokeButtons()[0];
    expect(first).toBeDefined();
    await user.click(first!);

    // The revoked token is read from the request rather than guessed from
    // the list's order.
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
      expect(queryRevokeButtons()).toHaveLength(1);
    });
    expect(showsExpiry(readPageText(), survivor)).toBe(true);
    expect(showsExpiry(readPageText(), revoked!)).toBe(false);
  });
});

describe("Fleet > add machine > personal", () => {
  it("adds the reserved flag to the join command", async () => {
    const user = userEvent.setup();
    await openApp([MOSS]);

    await user.click(screen.getByRole("button", { name: /add machine/i }));
    const plain = `hercule runner join ${window.location.origin} --token ${TOKEN}`;
    await waitFor(() => {
      expect(readPageText()).toContain(plain);
    });
    expect(readPageText()).not.toContain("--reserved");

    await user.click(screen.getByRole("checkbox", { name: /personal machine/i }));

    await waitFor(() => {
      expect(readPageText()).toContain(`${plain} --reserved`);
    });

    // Unticking the checkbox removes the flag again.
    await user.click(screen.getByRole("checkbox", { name: /personal machine/i }));
    await waitFor(() => {
      expect(readPageText()).not.toContain("--reserved");
    });
    expect(readPageText()).toContain(plain);
  });
});

describe("Fleet > opening a runner", () => {
  it("shows each runner's status and links to its page", async () => {
    await openApp([MOSS, SIRIUS]);

    const moss = await findRunnerRow(MOSS.name, [SIRIUS.name]);
    expect(readPageText(moss)).toContain(MOSS.connectivity);
    expect(findRowLink(moss)?.getAttribute("href")).toBe(`/fleet/${MOSS.id}`);

    // A draining runner shows its lifecycle: that is why a reader would open
    // it, and its connectivity does not show it.
    const sirius = await findRunnerRow(SIRIUS.name, [MOSS.name]);
    expect(readPageText(sirius)).toContain(SIRIUS.connectivity);
    expect(readPageText(sirius)).toContain(SIRIUS.lifecycle);
    expect(findRowLink(sirius)?.getAttribute("href")).toBe(`/fleet/${SIRIUS.id}`);
  });
});
