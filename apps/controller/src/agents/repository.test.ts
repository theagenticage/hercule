/**
 * Tests the agent listing. It pages with a keyset over `(created_at, id)`, and
 * the permission profile is its only filter. Deleting a profile uses that
 * filter, so it must return the agents that name that profile and no others.
 * Also tests the summaries that workflow validation reads for many agents.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { mintUuid, uuidToString, withTransaction } from "../db";
import { TestDatabase } from "../db/testing";
import { agentRepository } from "./repository";

/** Inserts a Provider Account row whose default harness is `defaultHarnessId`, and returns its id. */
const insertAccount = (defaultHarnessId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = mintUuid();
    yield* withTransaction(
      sql,
      sql`
        INSERT INTO provider_accounts
          (id, provider_id, kind, label, default_harness_id, created_at, updated_at)
        VALUES (${id}, 'acme/acme', 'api-key', NULL, ${defaultHarnessId},
                '2026-09-15T08:00:00.000Z', '2026-09-15T08:00:00.000Z')
      `,
    );
    return uuidToString(id);
  });

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

/** Returns a new canonical v7 id, the only id format the store accepts. */
const mintId = () => uuidToString(mintUuid());

/**
 * Inserts one agent under a profile, created at the given time so the listing
 * has an order. It runs in Claude Code unless `where` says otherwise.
 */
const insertAgent = (
  name: string,
  permissionProfileId: string,
  at: string,
  where: { providerAccountId: string; harnessId: string | null } = {
    providerAccountId: mintId(),
    harnessId: "claude-code/claude-code",
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const agents = yield* agentRepository;
    return yield* withTransaction(
      sql,
      agents.insert({
        kind: "agent",
        name,
        systemPrompt: "do the work",
        ...where,
        permissionProfileId,
        accessMode: "full-access",
        model: null,
        disallowedTools: [],
        at,
      }),
    );
  });

describe("listing the agents under one profile", () => {
  it("returns them oldest first and leaves out every other agent", async () => {
    const { listed, profileId } = await run(
      Effect.gen(function* () {
        const agents = yield* agentRepository;
        const profileId = mintId();
        yield* insertAgent("the-younger", profileId, "2026-09-15T11:00:00.000Z");
        yield* insertAgent("the-elder", profileId, "2026-09-15T10:00:00.000Z");
        // Another profile's agent, which the filter must leave out.
        yield* insertAgent("the-stranger", mintId(), "2026-09-15T09:00:00.000Z");
        const page = yield* agents.list({
          limit: 10,
          cursor: undefined,
          direction: "asc",
          permissionProfileId: profileId,
          kind: undefined,
        });
        return { listed: page.items, profileId };
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(listed.map((one) => one.name)).toEqual(["the-elder", "the-younger"]);
    expect(listed.every((one) => one.permissionProfileId === profileId)).toBe(true);
  });

  it("returns every agent when no profile is given", async () => {
    const listed = await run(
      Effect.gen(function* () {
        const agents = yield* agentRepository;
        yield* insertAgent("the-elder", mintId(), "2026-09-15T10:00:00.000Z");
        yield* insertAgent("the-younger", mintId(), "2026-09-15T11:00:00.000Z");
        const page = yield* agents.list({
          limit: 10,
          cursor: undefined,
          direction: "asc",
          permissionProfileId: undefined,
          kind: undefined,
        });
        return page.items;
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(listed.map((one) => one.name)).toEqual(["the-elder", "the-younger"]);
  });
});

describe("reading the summaries of agents by id", () => {
  it("gives each agent's kind, name and effective harness, and leaves out an id that names no agent", async () => {
    const { summaries, ids } = await run(
      Effect.gen(function* () {
        const agents = yield* agentRepository;
        const profileId = mintId();
        const at = "2026-09-15T10:00:00.000Z";
        const accountId = yield* insertAccount("codex/codex");
        const own = yield* insertAgent("own-harness", profileId, at, {
          providerAccountId: accountId,
          harnessId: "claude-code/claude-code",
        });
        const inherited = yield* insertAgent("account-default", profileId, at, {
          providerAccountId: accountId,
          harnessId: null,
        });
        // Its account is gone, so it has no harness to run in.
        const orphan = yield* insertAgent("no-account", profileId, at, {
          providerAccountId: mintId(),
          harnessId: null,
        });
        const summaries = yield* agents.readSummaries([own.id, inherited.id, orphan.id, mintId()]);
        return { summaries, ids: { own: own.id, inherited: inherited.id, orphan: orphan.id } };
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(Object.fromEntries(summaries)).toEqual({
      [ids.own]: {
        kind: "agent",
        name: "own-harness",
        effectiveHarnessId: "claude-code/claude-code",
      },
      [ids.inherited]: {
        kind: "agent",
        name: "account-default",
        effectiveHarnessId: "codex/codex",
      },
      [ids.orphan]: { kind: "agent", name: "no-account", effectiveHarnessId: null },
    });
  });
});
