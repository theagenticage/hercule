/**
 * Tests how probe results are stored, on a real database and the real plugin
 * host: one account is one person, so the first identity a probe reports
 * becomes the account's, and a probe that reports someone else is stored as
 * not signed in.
 */
import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import type { ProbeResult } from "@hercule/protocol";
import { withTransaction } from "../db";
import { ProviderAccountProbes, type ProbeOutcome } from "./probes";
import { providerAccountRepository } from "./repository";
import {
  addAccount,
  addRunner,
  ALPHA_HARNESS_ID,
  MACHINE_KIND,
  runWithAccounts,
  SIGNED_IN,
} from "./testing";

/** A probe result that shows someone signed in. */
const signedInAs = (identity: string, planLabel?: string): ProbeResult => ({
  ...SIGNED_IN,
  auth: {
    status: "ok",
    identity,
    ...(planLabel === undefined ? {} : { planLabel }),
  },
});

/** When the controller sent the probes in these tests. */
const SENT_AT = "2026-10-31T10:00:00.000Z";

/** What the controller read when it sent the probes in these tests. */
const STAMP = { sentAt: SENT_AT, credentialGeneration: 0 };

/** Returns the snapshot of a `stored` outcome, and fails the test for any other outcome. */
const requireStored = (outcome: ProbeOutcome) => {
  if (outcome._tag !== "stored") throw new Error(`expected a stored snapshot, got ${outcome._tag}`);
  return outcome.snapshot;
};

const readAccount = (accountId: string) =>
  Effect.gen(function* () {
    const accounts = yield* providerAccountRepository;
    return Option.getOrThrow(yield* accounts.one(accountId));
  });

describe("recording a probe", () => {
  it("reports a result sent before the snapshot already stored as superseded, stores nothing, and sets no identity from it", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbes;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        yield* probes.recordProbe(
          runner,
          account.id,
          ALPHA_HARNESS_ID,
          { ...SIGNED_IN, auth: { status: "ok" } },
          STAMP,
        );
        const stale = yield* probes.recordProbe(
          runner,
          account.id,
          ALPHA_HARNESS_ID,
          signedInAs("old@example.com"),
          { sentAt: "2026-10-31T09:59:59.000Z", credentialGeneration: 0 },
        );
        const accounts = yield* providerAccountRepository;
        return {
          stale,
          stored: Option.getOrThrow(
            yield* accounts.readSnapshot(account.id, ALPHA_HARNESS_ID, runner),
          ),
          account: yield* readAccount(account.id),
        };
      }),
    );

    expect(outcome.stale).toEqual({ _tag: "superseded" });
    expect(outcome.stored).toMatchObject({ probedAt: SENT_AT, auth: { status: "ok" } });
    expect(outcome.stored.auth.identity).toBeUndefined();
    expect(outcome.account.identity).toBeNull();
  });

  it("makes the first identity a probe reports the account's identity and plan", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbes;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        const snapshot = yield* probes.recordProbe(
          runner,
          account.id,
          ALPHA_HARNESS_ID,
          signedInAs("rogier@work.com", "Max"),
          STAMP,
        );
        return { snapshot: requireStored(snapshot), account: yield* readAccount(account.id) };
      }),
    );

    expect(outcome.account).toMatchObject({ identity: "rogier@work.com", planLabel: "Max" });
    expect(outcome.snapshot.auth).toMatchObject({ status: "ok", identity: "rogier@work.com" });
  });

  it("keeps a probe that reports the same person ok, whatever the letter case", async () => {
    const snapshot = await runWithAccounts(
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbes;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const first = yield* addRunner("laptop");
        const second = yield* addRunner("desktop");
        yield* probes.recordProbe(
          first,
          account.id,
          ALPHA_HARNESS_ID,
          signedInAs("a@work.com"),
          STAMP,
        );
        return requireStored(
          yield* probes.recordProbe(
            second,
            account.id,
            ALPHA_HARNESS_ID,
            signedInAs("A@Work.com"),
            STAMP,
          ),
        );
      }),
    );

    expect(snapshot.auth.status).toBe("ok");
  });

  it("stores a probe that reports someone else as unauthenticated, names both people, and keeps the account's identity", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbes;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const first = yield* addRunner("laptop");
        const second = yield* addRunner("desktop");
        yield* probes.recordProbe(
          first,
          account.id,
          ALPHA_HARNESS_ID,
          signedInAs("a@work.com"),
          STAMP,
        );
        const other = yield* probes.recordProbe(
          second,
          account.id,
          ALPHA_HARNESS_ID,
          signedInAs("b@home.com", "Pro"),
          STAMP,
        );
        const accounts = yield* providerAccountRepository;
        return {
          other: requireStored(other),
          account: yield* readAccount(account.id),
          stored: yield* accounts.readSnapshot(account.id, ALPHA_HARNESS_ID, second),
        };
      }),
    );

    expect(outcome.other.auth).toMatchObject({
      status: "unauthenticated",
      identity: "b@home.com",
      message: "Signed in as b@home.com; this account is a@work.com. Sign in again as a@work.com.",
    });
    expect(Option.getOrThrow(outcome.stored).auth).toEqual(outcome.other.auth);
    expect(outcome.account).toMatchObject({ identity: "a@work.com", planLabel: null });
  });

  it("stores exactly one of two first sign-ins as someone else, when they race", async () => {
    const statuses = await runWithAccounts(
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbes;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const first = yield* addRunner("laptop");
        const second = yield* addRunner("desktop");
        const results = yield* Effect.all(
          [
            probes.recordProbe(
              first,
              account.id,
              ALPHA_HARNESS_ID,
              signedInAs("a@work.com"),
              STAMP,
            ),
            probes.recordProbe(
              second,
              account.id,
              ALPHA_HARNESS_ID,
              signedInAs("b@home.com"),
              STAMP,
            ),
          ],
          { concurrency: "unbounded" },
        );
        return results.map((result) => requireStored(result).auth.status).toSorted();
      }),
    );

    expect(statuses).toEqual(["ok", "unauthenticated"]);
  });

  it("ignores the answer of a probe sent before the credential was replaced, so the new credential's own probe is not judged a mismatch", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbes;
        const sql = yield* SqlClient.SqlClient;
        const accounts = yield* providerAccountRepository;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        // The old key's probe is sent.
        const oldStamp = yield* probes.readProbeStamp(account.id);
        // The key is replaced, as `ProviderAccountService.update` does.
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* accounts.clearIdentity(account.id, "2026-10-31T10:00:01.000Z");
            yield* accounts.advanceCredentialGeneration(account.id, "2026-10-31T10:00:01.000Z");
          }),
        );
        // The old probe answers before the replacement's probe.
        const old = yield* probes.recordProbe(
          runner,
          account.id,
          ALPHA_HARNESS_ID,
          signedInAs("old@work.com"),
          oldStamp,
        );
        const afterOld = yield* readAccount(account.id);
        const newStamp = yield* probes.readProbeStamp(account.id);
        const fresh = yield* probes.recordProbe(
          runner,
          account.id,
          ALPHA_HARNESS_ID,
          signedInAs("new@home.com"),
          newStamp,
        );
        return {
          old,
          afterOld,
          fresh: requireStored(fresh),
          account: yield* readAccount(account.id),
        };
      }),
    );

    expect(outcome.old).toEqual({ _tag: "superseded" });
    expect(outcome.afterOld.identity).toBeNull();
    expect(outcome.fresh.auth).toMatchObject({ status: "ok", identity: "new@home.com" });
    expect(outcome.account.identity).toBe("new@home.com");
  });

  it("reports an answer from before the credential changed as superseded, and changes nothing", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbes;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        const oldStamp = yield* probes.readProbeStamp(account.id);
        yield* probes.acceptDeviceSignIn(account.id, runner, ALPHA_HARNESS_ID);
        const current = yield* probes.readProbeStamp(account.id);
        yield* probes.recordProbe(
          runner,
          account.id,
          ALPHA_HARNESS_ID,
          { ...SIGNED_IN, auth: { status: "unauthenticated" } },
          current,
        );
        const old = yield* probes.recordProbe(
          runner,
          account.id,
          ALPHA_HARNESS_ID,
          signedInAs("old@work.com"),
          oldStamp,
        );
        const accounts = yield* providerAccountRepository;
        return {
          old,
          stored: Option.getOrThrow(
            yield* accounts.readSnapshot(account.id, ALPHA_HARNESS_ID, runner),
          ),
          account: yield* readAccount(account.id),
        };
      }),
    );

    expect(outcome.old).toEqual({ _tag: "superseded" });
    expect(outcome.stored.auth.status).toBe("unauthenticated");
    expect(outcome.account.identity).toBeNull();
  });

  it("leaves the account's identity alone for a probe that reports none, or that is not ok", async () => {
    const account = await runWithAccounts(
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbes;
        const created = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        yield* probes.recordProbe(
          runner,
          created.id,
          ALPHA_HARNESS_ID,
          {
            ...SIGNED_IN,
            auth: { status: "ok" },
          },
          STAMP,
        );
        yield* probes.recordProbe(
          runner,
          created.id,
          ALPHA_HARNESS_ID,
          {
            ...SIGNED_IN,
            auth: { status: "unauthenticated", identity: "someone@example.com" },
          },
          STAMP,
        );
        return yield* readAccount(created.id);
      }),
    );

    expect(account.identity).toBeNull();
  });
});

describe("probe stamps", () => {
  it("strictly increase, also while the clock stands still", async () => {
    const sentAt = await runWithAccounts(
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbes;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        yield* TestClock.setTime(Date.parse(SENT_AT));
        const stamps = [
          yield* probes.readProbeStamp(account.id),
          yield* probes.readProbeStamp(account.id),
          yield* probes.readProbeStamp(account.id),
        ];
        return stamps.map((stamp) => stamp.sentAt);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    expect(sentAt).toEqual([
      "2026-10-31T10:00:00.000Z",
      "2026-10-31T10:00:00.001Z",
      "2026-10-31T10:00:00.002Z",
    ]);
  });

  it("let the later probe win when two probes of one pair were sent in the same millisecond", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbes;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        yield* TestClock.setTime(Date.parse(SENT_AT));
        const first = yield* probes.readProbeStamp(account.id);
        const second = yield* probes.readProbeStamp(account.id);
        const accounts = yield* providerAccountRepository;
        // The later probe answers first.
        yield* probes.recordProbe(runner, account.id, ALPHA_HARNESS_ID, SIGNED_IN, second);
        const late = yield* probes.recordProbe(
          runner,
          account.id,
          ALPHA_HARNESS_ID,
          { ...SIGNED_IN, auth: { status: "unauthenticated" } },
          first,
        );
        return {
          late,
          stored: Option.getOrThrow(
            yield* accounts.readSnapshot(account.id, ALPHA_HARNESS_ID, runner),
          ),
        };
      }).pipe(Effect.provide(TestClock.layer())),
    );

    expect(outcome.late).toEqual({ _tag: "superseded" });
    expect(outcome.stored.auth.status).toBe("ok");
  });
});

describe("accepting a device sign-in", () => {
  it("marks that runner's snapshot as not signed in, and leaves the other runners' snapshots alone", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbes;
        const accounts = yield* providerAccountRepository;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const signedIn = yield* addRunner("laptop");
        const other = yield* addRunner("desktop");
        yield* probes.recordProbe(
          signedIn,
          account.id,
          ALPHA_HARNESS_ID,
          signedInAs("a@work.com"),
          yield* probes.readProbeStamp(account.id),
        );
        yield* probes.recordProbe(
          other,
          account.id,
          ALPHA_HARNESS_ID,
          signedInAs("a@work.com"),
          yield* probes.readProbeStamp(account.id),
        );
        const before = Option.getOrThrow(
          yield* accounts.readSnapshot(account.id, ALPHA_HARNESS_ID, signedIn),
        );
        yield* probes.acceptDeviceSignIn(account.id, signedIn, ALPHA_HARNESS_ID);
        return {
          before,
          marked: Option.getOrThrow(
            yield* accounts.readSnapshot(account.id, ALPHA_HARNESS_ID, signedIn),
          ),
          untouched: Option.getOrThrow(
            yield* accounts.readSnapshot(account.id, ALPHA_HARNESS_ID, other),
          ),
        };
      }),
    );

    expect(outcome.marked.auth).toMatchObject({
      status: "unauthenticated",
      message: "Checking the sign-in…",
    });
    expect(outcome.marked.probedAt).toBe(outcome.before.probedAt);
    expect(outcome.untouched.auth.status).toBe("ok");
  });
});
