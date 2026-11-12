/**
 * Tests what the Inbox draws above a card when its source is a tracker with a
 * deep, many-parent hierarchy, through the real repository and a migrated
 * database. The invented tracker has tickets (a compact, fast kind) that lie
 * under a parent ticket, a project and a milestone, projects that lie in two
 * initiatives, and a team. A second invented plugin, a code forge, has pull
 * requests.
 *
 * - every place above a ticket, by every path, each once
 * - a ticket that moves to another project while its own row stays the same
 * - progress and dates: only what the source reports, and nothing for a
 *   place nobody can open
 * - turning a plugin off: its cards and places keep drawing, marked as not
 *   kept current, and the other plugin is untouched
 *
 * The generic walks (depth limits, loops, statement counts) are tested in
 * `relation-claims.test.ts` and `repository.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { uuidFromString } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { MAX_ENTITY_ANCESTORS } from "@hercule/contract";
import { externalEntityInbox } from "./inbox-query";
import { externalEntityRepository, type ObservedEntity } from "./repository";
import type { EntitySlots, FullEntityObservation } from "./slots";

const BASE = Date.parse("2026-03-01T00:00:00.000Z");
const MINUTE = 60_000;
const at = (minutes: number): string => new Date(BASE + minutes * MINUTE).toISOString();

const TRACKER = "acme-tracker";
const FORGE = "acme-forge";
const TRACKER_ACCOUNT = "0190c000-0000-7000-8000-0000000000b1";
const FORGE_ACCOUNT = "0190c000-0000-7000-8000-0000000000b2";

const TICKET_KIND = `${TRACKER}/ticket`;
const PULL_REQUEST_KIND = `${FORGE}/pull-request`;

const ref = (word: string, name: string) => `${TRACKER}:${word}:${name}`;
const TICKET = ref("ticket", "shop-7");
const PARENT_TICKET = ref("ticket", "shop-1");
const HARBOUR = ref("project", "harbour");
const LIGHTHOUSE = ref("project", "lighthouse");
const LAUNCH = ref("milestone", "launch");
const GROWTH = ref("initiative", "growth");
const RELIABILITY = ref("initiative", "reliability");
const COMPANY = ref("initiative", "company");
const SHOP_TEAM = ref("team", "shop");
const PULL_REQUEST = `${FORGE}:pull-request:acme/shop#41`;
const FORGE_REPOSITORY = `${FORGE}:repository:acme/shop`;

const COMPACT_FAST = {
  card: "compact",
  pace: "fast",
  patience: 24,
  facts: [],
} as const;
const TICKET_SLOTS: EntitySlots = { ...COMPACT_FAST, noun: "Ticket", identifier: "SHOP" };
const placeSlots = (noun: string): EntitySlots => ({
  noun,
  pace: "context",
  caption: `Tracker ${noun.toLowerCase()}`,
});

type Relations = NonNullable<FullEntityObservation["relations"]>;
const partOf = (...parents: ReadonlyArray<string>): Relations => ({
  complete: true,
  partOf: parents,
  linked: [],
});

/** Builds a ticket observation. A ticket with `concerns: []` is a record without a card. */
const ticket = (
  ticketRef: string,
  relations: Relations,
  options: { readonly concerns?: ReadonlyArray<"assigned"> } = {},
): ObservedEntity => ({
  kind: TICKET_KIND,
  slots: TICKET_SLOTS,
  observation: {
    kind: "ticket",
    ref: ticketRef,
    title: `Title of ${ticketRef}`,
    url: "https://tracker.example/t",
    lifecycle: "open",
    fields: {},
    concerns: options.concerns ?? ["assigned"],
    sourceUpdatedAt: at(1),
    relations,
  },
  fieldRows: [],
});

/** Builds the observation of a place of `word` (project, initiative, milestone, team) with no card. */
const place = (
  placeRef: string,
  noun: string,
  options: {
    readonly relations?: Relations;
    readonly progress?: NonNullable<FullEntityObservation["progress"]>;
    readonly targetDate?: string;
  } = {},
): ObservedEntity => ({
  kind: `${TRACKER}/${placeRef.split(":")[1]}`,
  slots: placeSlots(noun),
  observation: {
    kind: placeRef.split(":")[1]!,
    ref: placeRef,
    title: `Title of ${placeRef}`,
    fields: {},
    concerns: [],
    sourceUpdatedAt: at(1),
    ...options,
  },
  fieldRows: [],
});

const pullRequest = (relations: Relations): ObservedEntity => ({
  kind: PULL_REQUEST_KIND,
  slots: { ...COMPACT_FAST, noun: "Pull request", identifier: "#41" },
  observation: {
    kind: "pull-request",
    ref: PULL_REQUEST,
    title: "Retry webhooks",
    url: "https://forge.example/pr/41",
    lifecycle: "open",
    fields: {},
    concerns: ["assigned"],
    sourceUpdatedAt: at(1),
    relations,
  },
  fieldRows: [],
});

const forgeRepository = (): ObservedEntity => ({
  kind: `${FORGE}/repository`,
  slots: placeSlots("Repository"),
  observation: {
    kind: "repository",
    ref: FORGE_REPOSITORY,
    title: "acme/shop",
    fields: {},
    concerns: [],
    sourceUpdatedAt: at(1),
  },
  fieldRows: [],
});

const environment = (
  minutes: number,
  activePluginIds: ReadonlyArray<string> = [TRACKER, FORGE],
) => ({
  now: at(minutes),
  activePluginIds,
  askingKinds: [],
});

type Repository = Effect.Success<typeof externalEntityRepository>;

/** Reads what lies above one thing, as a detail reads it, and the thing's own row on the Inbox. */
const readAbove = (
  repository: Repository,
  startRef: string,
  minutes: number,
  active?: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const readEnvironment = environment(minutes, active);
    const context = yield* repository.readContext({
      starts: [startRef],
      maxAncestors: MAX_ENTITY_ANCESTORS,
      maxPlaces: MAX_ENTITY_ANCESTORS * 2,
      environment: readEnvironment,
    });
    const page = yield* (yield* externalEntityInbox).queryInbox(
      { ...readEnvironment, signalKinds: [], savedQueries: [], askingKinds: [] },
      { list: { savedQuery: "everything" } },
    );
    return {
      ancestors: context.ancestors.get(startRef) ?? [],
      contextComplete: context.contextComplete.get(startRef),
      places: context.places,
      edges: context.edges,
      thing: page.things.find((one) => one.ref === startRef),
    };
  });

/** Runs `body` on a fresh migrated database with one Connection for each plugin, in one transaction. */
const run = <A>(
  body: (context: {
    readonly repository: Effect.Success<typeof externalEntityRepository>;
    /** Stores a complete read of one kind by the tracker's Connection. */
    readonly readTracker: (
      kind: string,
      observed: ReadonlyArray<ObservedEntity>,
      minutes: number,
    ) => Effect.Effect<{ readonly changedRefs: ReadonlyArray<string> }, unknown>;
    readonly readForge: (
      kind: string,
      observed: ReadonlyArray<ObservedEntity>,
      minutes: number,
    ) => Effect.Effect<unknown, unknown>;
  }) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const [plugin, account] of [
        [TRACKER, TRACKER_ACCOUNT],
        [FORGE, FORGE_ACCOUNT],
      ] as const) {
        yield* sql`INSERT INTO plugins (id, enabled, config, created_at, updated_at)
          VALUES (${plugin}, 1, '{}', ${at(0)}, ${at(0)})`;
        yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
            status, labels, config, created_at, updated_at)
          VALUES (${uuidFromString(account)}, ${plugin}, ${`${plugin}/account`}, 'a', 'a', 'a',
            'connected', '[]', '{}', ${at(0)}, ${at(0)})`;
      }
      const repository = yield* externalEntityRepository;
      const read =
        (plugin: string, connectionId: string) =>
        (kind: string, observed: ReadonlyArray<ObservedEntity>, minutes: number) =>
          Effect.gen(function* () {
            const changes = yield* repository.reconcile({
              connectionId,
              kind,
              complete: true,
              observed,
              actor: `plugin:${plugin}`,
              environment: environment(minutes),
            });
            const changedRefs: Array<string> = [];
            for (const id of changes.entityIds) {
              const rows = yield* sql<{ readonly ref: string }>`
                SELECT ref FROM external_entities WHERE id = ${uuidFromString(id)}`;
              changedRefs.push(rows[0]!.ref);
            }
            return { changedRefs: changedRefs.sort() };
          });
      return yield* body({
        repository,
        readTracker: read(TRACKER, TRACKER_ACCOUNT),
        readForge: read(FORGE, FORGE_ACCOUNT),
      });
    }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
  );

type Context = Parameters<Parameters<typeof run>[0]>[0];

/**
 * Stores the whole tracker. The ticket is part of its parent ticket, a project
 * and a milestone. The parent ticket is part of another project. The project
 * is in two initiatives and a team, and the second project is in one of them.
 * Both initiatives are part of the company initiative.
 */
const readTrackerGraph = (
  { readTracker }: Context,
  options: { readonly ticketParents?: ReadonlyArray<string> } = {},
) =>
  Effect.gen(function* () {
    const ticketParents = options.ticketParents ?? [PARENT_TICKET, HARBOUR, LAUNCH];
    const moved = yield* readTracker(
      TICKET_KIND,
      [
        ticket(TICKET, partOf(...ticketParents)),
        ticket(PARENT_TICKET, partOf(LIGHTHOUSE), { concerns: [] }),
      ],
      2,
    );
    yield* readTracker(
      `${TRACKER}/project`,
      [
        place(HARBOUR, "Project", {
          relations: partOf(GROWTH, RELIABILITY, SHOP_TEAM),
          progress: { fraction: 0.4, done: 4, total: 10 },
          targetDate: at(500),
        }),
        place(LIGHTHOUSE, "Project", { relations: partOf(RELIABILITY) }),
      ],
      3,
    );
    yield* readTracker(
      `${TRACKER}/initiative`,
      [
        place(GROWTH, "Initiative", { relations: partOf(COMPANY) }),
        place(RELIABILITY, "Initiative", { relations: partOf(COMPANY) }),
        place(COMPANY, "Initiative"),
      ],
      4,
    );
    yield* readTracker(`${TRACKER}/milestone`, [place(LAUNCH, "Milestone")], 5);
    yield* readTracker(`${TRACKER}/team`, [place(SHOP_TEAM, "Team")], 6);
    return moved;
  });

const sorted = (values: Iterable<string>) => [...values].sort();
const edgePairs = (edges: ReadonlyArray<{ fromRef: string; toRef: string }>) =>
  sorted(edges.map((edge) => `${edge.fromRef} > ${edge.toRef}`));

describe("the places above a ticket of a deep tracker", () => {
  it("lists every place by every path, each once, and follows the ticket when it moves to another project", async () => {
    const outcome = await run((context) =>
      Effect.gen(function* () {
        yield* readTrackerGraph(context);
        const before = yield* readAbove(context.repository, TICKET, 10);
        // The ticket's own fields stay the same: only its parents change.
        const moved = yield* readTrackerGraph(context, { ticketParents: [LIGHTHOUSE] });
        const after = yield* readAbove(context.repository, TICKET, 11);
        return { before, moved, after };
      }),
    );

    const card = outcome.before;
    expect(sorted(card.ancestors)).toEqual(
      sorted([PARENT_TICKET, HARBOUR, LAUNCH, LIGHTHOUSE, GROWTH, RELIABILITY, COMPANY, SHOP_TEAM]),
    );
    expect(card.contextComplete).toBe(true);
    // The project is in two initiatives, and both are in the company: one place and one edge each.
    expect(edgePairs(outcome.before.edges)).toEqual(
      sorted([
        `${TICKET} > ${PARENT_TICKET}`,
        `${TICKET} > ${HARBOUR}`,
        `${TICKET} > ${LAUNCH}`,
        `${PARENT_TICKET} > ${LIGHTHOUSE}`,
        `${HARBOUR} > ${GROWTH}`,
        `${HARBOUR} > ${RELIABILITY}`,
        `${HARBOUR} > ${SHOP_TEAM}`,
        `${LIGHTHOUSE} > ${RELIABILITY}`,
        `${GROWTH} > ${COMPANY}`,
        `${RELIABILITY} > ${COMPANY}`,
      ]),
    );
    expect(sorted(outcome.before.places.map((one) => one.ref))).toEqual(
      sorted([PARENT_TICKET, HARBOUR, LIGHTHOUSE, LAUNCH, GROWTH, RELIABILITY, COMPANY, SHOP_TEAM]),
    );

    // The move reports the ticket as changed, though its own row is the same.
    expect(outcome.moved.changedRefs).toEqual([TICKET]);
    const movedCard = outcome.after;
    expect(sorted(movedCard.ancestors)).toEqual(sorted([LIGHTHOUSE, RELIABILITY, COMPANY]));
    expect(edgePairs(outcome.after.edges)).toEqual(
      sorted([
        `${TICKET} > ${LIGHTHOUSE}`,
        `${LIGHTHOUSE} > ${RELIABILITY}`,
        `${RELIABILITY} > ${COMPANY}`,
      ]),
    );
    expect(outcome.after.places.map((one) => one.ref)).not.toContain(HARBOUR);
  });
});

describe("what a place says of itself", () => {
  it("shows progress and a date only when the source reports them, never works them out, and hides them for a place nobody can open", async () => {
    const outcome = await run((context) =>
      Effect.gen(function* () {
        yield* readTrackerGraph(context);
        const reported = yield* readAbove(context.repository, TICKET, 10);
        yield* context.repository.reportMissing({
          connectionId: TRACKER_ACCOUNT,
          ref: HARBOUR,
          reason: "inaccessible",
          environment: environment(11),
        });
        const closed = yield* readAbove(context.repository, TICKET, 12);
        return { reported, closed };
      }),
    );
    const placeOf = (inbox: typeof outcome.reported, placeRef: string) =>
      inbox.places.find((one) => one.ref === placeRef)!;

    expect(placeOf(outcome.reported, HARBOUR)).toMatchObject({
      title: `Title of ${HARBOUR}`,
      progress: { fraction: 0.4, done: 4, total: 10 },
      targetDate: at(500),
      restricted: false,
    });
    // The ticket sits in the milestone and the other project, which report nothing: no bar, no date.
    for (const quiet of [LAUNCH, LIGHTHOUSE, SHOP_TEAM]) {
      const shown = placeOf(outcome.reported, quiet);
      expect(shown).not.toHaveProperty("progress");
      expect(shown).not.toHaveProperty("targetDate");
    }

    const restricted = placeOf(outcome.closed, HARBOUR);
    expect(restricted).toEqual({
      ref: HARBOUR,
      kind: `${TRACKER}/project`,
      noun: "Project",
      caption: "Tracker project",
      restricted: true,
    });
  });
});

describe("turning a plugin off", () => {
  it("keeps drawing its cards, places and parents as not kept current, and leaves the other plugin's cards current", async () => {
    const outcome = await run((context) =>
      Effect.gen(function* () {
        yield* readTrackerGraph(context);
        yield* context.readForge(`${FORGE}/repository`, [forgeRepository()], 7);
        yield* context.readForge(PULL_REQUEST_KIND, [pullRequest(partOf(FORGE_REPOSITORY))], 8);
        const running = yield* readAbove(context.repository, TICKET, 10);
        const forgeOnly = yield* readAbove(context.repository, TICKET, 11, [FORGE]);
        const forgeRequest = yield* readAbove(context.repository, PULL_REQUEST, 11, [FORGE]);
        return { running, forgeOnly, forgeRequest };
      }),
    );
    expect(outcome.running.thing).toMatchObject({ stale: false });
    expect(outcome.running.contextComplete).toBe(true);

    const ticketCard = outcome.forgeOnly;
    const runningCard = outcome.running;
    // The card and its parents are the ones that were drawn, now marked as not kept current.
    expect(ticketCard.thing).toMatchObject({ title: runningCard.thing!.title, stale: true });
    expect(ticketCard.contextComplete).toBe(false);
    expect(ticketCard.ancestors).toEqual(runningCard.ancestors);
    expect(outcome.forgeOnly.places.map((one) => one.ref).sort()).toEqual(
      outcome.running.places.map((one) => one.ref).sort(),
    );
    expect(outcome.forgeOnly.places.find((one) => one.ref === HARBOUR)).toMatchObject({
      title: `Title of ${HARBOUR}`,
      restricted: false,
    });
    expect(edgePairs(outcome.forgeOnly.edges)).toEqual(edgePairs(outcome.running.edges));

    expect(outcome.forgeRequest.thing).toMatchObject({ stale: false });
    expect(outcome.forgeRequest.contextComplete).toBe(true);
  });
});
