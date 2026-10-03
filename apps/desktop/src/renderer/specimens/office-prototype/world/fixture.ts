/**
 * PROTOTYPE - the fixture world of docs/design/shared/CONTENT.md, Tuesday
 * 29 September 2026 at 09:41: 16 live sessions (8 working, 3 waiting on
 * Rogier, 1 paused, 4 idle) on three runners, plus Triage and Juno, who hold
 * no session. `buildWorld` also grows the fleet to 48 and to 140 colleagues
 * for the scale story.
 *
 * Each session's id hashes, through `buildLook`, to the look the Bureau
 * book's CAST table gives its title, so the sidebar's face and the office's
 * character are the same colleague. `node /tmp/office-seeds.ts` found them
 * the way scripts/find-look-seeds.ts does.
 */
import { buildLook, HUES, SHAPES, WARDROBE } from "../../../faces/look";
import { FIX_THREAD_ID, MIGRATE_THREAD_ID } from "../../sidebar-fixture";
import type {
  Area,
  Colleague,
  CrewLook,
  FleetSize,
  OfficeRequest,
  Pose,
  ProjectKey,
  RunnerInfo,
  World,
} from "./types";
import { AREA_PROJECT } from "./types";

/** The UUIDv7 prefix every fixture session id shares. */
const ID = "01a0ec64-6e80-7000-8000-";

/** The session ids, each hashing to its CAST look. */
export const SESSION_IDS = {
  fix: FIX_THREAD_ID,
  read: `${ID}000000000203`,
  migrate: MIGRATE_THREAD_ID,
  investigate: `${ID}00000000003b`,
  refactor: `${ID}00000000000c`,
  webhook: `${ID}0000000000f7`,
  rounding: `${ID}0000000001ae`,
  payout: `${ID}00000000002d`,
  rotate: `${ID}00000000006f`,
  tidy: `${ID}00000000001e`,
  label: `${ID}00000000000b`,
  ship: `${ID}000000000043`,
  ideal: `${ID}0000000000d5`,
  draft: `${ID}000000000002`,
} as const;

const STUDIO_MAC: RunnerInfo = { id: "r-studio-mac", name: "studio-mac", slots: 6, local: true };
const BUILD_BOX_1: RunnerInfo = {
  id: "r-build-box-1",
  name: "build-box-1",
  slots: 8,
  local: false,
};
const BUILD_BOX_2: RunnerInfo = {
  id: "r-build-box-2",
  name: "build-box-2",
  slots: 8,
  local: false,
};

/** Returns the look a session id hashes to, as the sidebar draws it. */
const lookOf = (id: string): CrewLook => ({ ...buildLook(id), headwear: null });

/** Builds one session's colleague. */
const session = (
  key: keyof typeof SESSION_IDS,
  fields: Omit<Colleague, "id" | "role" | "look" | "threadId" | "project"> & {
    readonly threadId?: string | null;
  },
): Colleague => {
  const id = SESSION_IDS[key];
  return {
    id,
    role: "session",
    look: lookOf(id),
    project: AREA_PROJECT[fields.area],
    threadId: fields.threadId ?? null,
    ...fields,
  };
};

const PUSH: OfficeRequest = {
  kind: "command",
  short: "Run git push?",
  prompt: "git push -u origin fix/3ds-eu-cards",
  answers: ["Allow once", "Always allow git push", "Deny"],
  waitingMinutes: 10,
};

const GRAFANA: OfficeRequest = {
  kind: "question",
  short: "Keep the old Grafana folder?",
  prompt: "Keep the old Grafana folder?",
  answers: ["Keep", "Delete"],
  waitingMinutes: 6,
};

const NPM: OfficeRequest = {
  kind: "command",
  short: "Publish to npm?",
  prompt: "npm publish --access public  # payments-api 2.15.0",
  answers: ["Allow once", "Deny"],
  waitingMinutes: 2,
};

/** The 16 live sessions, Triage and Juno, as CONTENT.md lists them. */
const TODAY: ReadonlyArray<Colleague> = [
  session("fix", {
    name: "Fix 3-D Secure checkout",
    title: "Fix 3-D Secure checkout for EU cards",
    pose: "waiting",
    stateLabel: "waiting 10m",
    area: "checkout",
    runnerId: STUDIO_MAC.id,
    model: "Opus 5.5",
    activity: [
      "Read src/checkout/payment.ts",
      "Wrote a failing test for requires_action",
      "Edited src/checkout/3ds-modal.tsx",
      "Ran pnpm test checkout - 24 passed",
      "Asked to run git push -u origin fix/3ds-eu-cards",
    ],
    request: PUSH,
    threadId: FIX_THREAD_ID,
  }),
  session("read", {
    name: "Stripe v14 changelog",
    title: "Read the Stripe v14 changelog",
    pose: "idle",
    stateLabel: "idle 20m",
    area: "research",
    runnerId: STUDIO_MAC.id,
    model: "Sonnet 5",
    activity: [
      "Fetched stripe.com/docs/upgrades#2026-08-14",
      "Summarised 11 breaking changes",
      "Flagged requires_action for 3-D Secure",
    ],
    request: null,
  }),
  session("migrate", {
    name: "Migrate ops dashboards",
    title: "Migrate ops dashboards",
    pose: "waiting",
    stateLabel: "waiting 6m",
    area: "dashboards",
    runnerId: STUDIO_MAC.id,
    model: "qwen3-coder",
    activity: [
      "Exported 14 dashboards from Grafana 10",
      "Rewrote 9 panels for the new datasource",
      "Asked: Keep the old Grafana folder?",
    ],
    request: GRAFANA,
    threadId: MIGRATE_THREAD_ID,
  }),
  {
    id: "a-ada",
    name: "Ada",
    title: "Ada",
    role: "assistant",
    look: { hue: "iris", shape: "egg", accessories: [], headwear: "cloche" },
    pose: "working",
    stateLabel: "heartbeat",
    project: null,
    area: "assistants",
    runnerId: STUDIO_MAC.id,
    model: "Sonnet 5",
    activity: [
      "09:00 heartbeat: one urgent thing from Triage",
      "Set a reminder: renew the SSL cert, Fri 09:00",
      "Rogier asked: What's the status of the backup job?",
      "Checking with Investigate backup timeouts…",
    ],
    request: null,
    threadId: null,
  },
  {
    id: "a-milo",
    name: "Milo",
    title: "Milo",
    role: "assistant",
    look: { hue: "teal", shape: "round", accessories: [], headwear: "headset" },
    pose: "idle",
    stateLabel: "idle",
    project: null,
    area: "assistants",
    runnerId: STUDIO_MAC.id,
    model: "gpt-5.4",
    activity: ["Started Investigate backup timeouts at 09:35", "Listening on Slack #ops"],
    request: null,
    threadId: null,
  },
  session("investigate", {
    name: "Backup timeouts",
    title: "Investigate backup timeouts",
    pose: "working",
    stateLabel: "6m",
    area: "infra",
    runnerId: BUILD_BOX_1.id,
    model: "gpt-5.4",
    activity: [
      "Read the ops-db backup logs for 14 nights",
      "pg_dump got slower once events passed 40 GB",
      "Running EXPLAIN on the events table",
    ],
    request: null,
  }),
  session("refactor", {
    name: "Refactor cart totals",
    title: "Refactor cart totals",
    pose: "working",
    stateLabel: "22m",
    area: "cart",
    runnerId: BUILD_BOX_1.id,
    model: "Sonnet 5",
    activity: [
      "Moved totals into src/cart/totals.ts",
      "Replaced 6 call sites",
      "Running pnpm test cart",
    ],
    request: null,
  }),
  session("webhook", {
    name: "Webhook retry backoff",
    title: "Webhook retry backoff",
    pose: "working",
    stateLabel: "3m",
    area: "webhooks",
    runnerId: BUILD_BOX_1.id,
    model: "Opus 5.5",
    activity: ["Read src/webhooks/retry.ts", "Writing an exponential backoff with jitter"],
    request: null,
  }),
  session("rounding", {
    name: "Cart total rounding",
    title: "Cart total rounding on discounts",
    pose: "working",
    stateLabel: "14m",
    area: "cart",
    runnerId: BUILD_BOX_1.id,
    model: "Sonnet 5",
    activity: [
      "Reproduced: 3 × €9.99 with 15% off shows €25.47",
      "Rounding per line instead of per total",
      "Editing src/cart/discounts.ts",
    ],
    request: null,
  }),
  session("payout", {
    name: "Payout report",
    title: "Payout report for September",
    pose: "working",
    stateLabel: "9m",
    area: "payouts",
    runnerId: BUILD_BOX_1.id,
    model: "gpt-5.4",
    activity: ["Pulled 1,204 Stripe payouts", "Grouping by currency", "Drafting the CSV"],
    request: null,
  }),
  session("rotate", {
    name: "Staging secrets",
    title: "Rotate staging secrets",
    pose: "working",
    stateLabel: "11m",
    area: "secrets",
    runnerId: BUILD_BOX_1.id,
    model: "Sonnet 5",
    activity: ["Listed 23 staging secrets", "Rotated 15 of 23", "Restarting staging-api"],
    request: null,
  }),
  session("tidy", {
    name: "Tidy checkout CSS",
    title: "Tidy checkout CSS",
    pose: "idle",
    stateLabel: "idle 2h",
    area: "checkout",
    runnerId: BUILD_BOX_1.id,
    model: "Haiku 4.5",
    activity: ["Removed 41 unused rules", "Finished: 3 files changed"],
    request: null,
  }),
  session("label", {
    name: "Label new issues",
    title: "Label new issues",
    pose: "paused",
    stateLabel: "paused",
    area: "triage",
    runnerId: BUILD_BOX_1.id,
    model: null,
    activity: ["Labelled 50 issues this hour", "Bound tripped: 34 events held"],
    request: null,
  }),
  session("ship", {
    name: "Ship release v2.15",
    title: "Ship release v2.15",
    pose: "waiting",
    stateLabel: "waiting 2m",
    area: "release",
    runnerId: BUILD_BOX_2.id,
    model: "Sonnet 5",
    activity: [
      "Bumped payments-api to 2.15.0",
      "Wrote the changelog",
      "Built and packed the tarball",
      "Asked to publish to npm",
    ],
    request: NPM,
  }),
  session("ideal", {
    name: "iDEAL research",
    title: "Add iDEAL research",
    pose: "idle",
    stateLabel: "idle 1h",
    area: "research",
    runnerId: BUILD_BOX_2.id,
    model: "gpt-5.4",
    activity: ["Compared Stripe and Mollie for iDEAL", "Wrote research/ideal.md"],
    request: null,
  }),
  session("draft", {
    name: "Draft reply to Jonas",
    title: "Draft reply to Jonas at Kiteworks",
    pose: "working",
    stateLabel: "1m",
    area: "correspondence",
    runnerId: BUILD_BOX_2.id,
    model: "Haiku 4.5",
    activity: ["Read Jonas's mail about API limits", "Drafting the reply"],
    request: null,
  }),
  {
    id: "w-triage",
    name: "Triage",
    title: "Triage",
    role: "triage",
    look: { hue: "lime", shape: "egg", accessories: ["tache", "bowtie"], headwear: null },
    pose: "idle",
    stateLabel: "next 11:00",
    project: null,
    area: "triage",
    runnerId: null,
    model: "Sonnet 5",
    activity: [
      "09:00 run took 42s",
      "212 events → 5 proposals, 2 offers, 3 FYI",
      "Pinned: Checkout fails for EU cards with 3-D Secure",
    ],
    request: null,
    threadId: null,
  },
  {
    id: "a-juno",
    name: "Juno",
    title: "Juno",
    role: "assistant",
    look: { hue: "orchid", shape: "tall", accessories: [], headwear: "beret" },
    pose: "asleep",
    stateLabel: "asleep",
    project: null,
    area: "assistants",
    runnerId: null,
    model: "Haiku 4.5",
    activity: ["Unloaded after 30m without a message", "Discord #support is reconnecting"],
    request: null,
    threadId: null,
  },
];

/** A seeded pseudo-random generator, so a fleet size always draws the same office. */
const createRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** The titles the larger fleets draw from, per area. */
const TITLES: Readonly<Record<Area, ReadonlyArray<string>>> = {
  checkout: [
    "Apple Pay sheet height",
    "Guest checkout email",
    "Address autocomplete",
    "Klarna redirect",
  ],
  cart: ["Cart badge flicker", "Save cart for later", "Bundle discounts", "Cart sync on login"],
  webhooks: [
    "Webhook signature v2",
    "Dead-letter replays",
    "Idempotency keys",
    "Webhook dashboard",
  ],
  payouts: ["Payout fees by country", "Payout CSV in euros", "Reconcile August", "Payout alerts"],
  infra: ["Postgres 17 upgrade", "Shrink CI images", "Fix flaky deploy", "Disk alerts on ops-db"],
  dashboards: [
    "Latency SLO board",
    "Grafana alert rules",
    "Error budget panel",
    "Queue depth panel",
  ],
  secrets: ["Rotate prod secrets", "Vault policy audit", "Expire old tokens", "SOPS for staging"],
  research: [
    "Compare Adyen fees",
    "Read the Postgres 17 notes",
    "Passkeys at checkout",
    "Tax rules NL",
  ],
  review: [
    "Review PR #412",
    "Review PR #418",
    "Review PR #421",
    "Review PR #430",
    "Review PR #433",
  ],
  release: ["Ship webshop 4.2", "Ship release v2.16", "Hotfix 2.15.1", "Tag ops 1.9"],
  correspondence: [
    "Reply to Marta",
    "Answer support #881",
    "Weekly update to Brightline",
    "Reply to Kiteworks",
  ],
  triage: ["Label new issues", "Close stale issues", "Dedupe Sentry alerts"],
  assistants: [],
};

/** The areas the larger fleets fill, weighted by how often they appear. */
const AREA_WEIGHTS: ReadonlyArray<readonly [Area, number]> = [
  ["checkout", 10],
  ["cart", 9],
  ["webhooks", 9],
  ["payouts", 6],
  ["infra", 9],
  ["dashboards", 5],
  ["secrets", 4],
  ["research", 8],
  ["review", 14],
  ["release", 5],
  ["correspondence", 6],
  ["triage", 3],
];

/** The poses of the larger fleets, weighted as the book's 10x office counts them. */
const POSE_WEIGHTS: ReadonlyArray<readonly [Pose, number]> = [
  ["working", 52],
  ["waiting", 20],
  ["idle", 16],
  ["paused", 5],
  ["failed", 2],
  ["done", 4],
  ["away", 1],
];

const pickWeighted = <T>(random: () => number, weights: ReadonlyArray<readonly [T, number]>): T => {
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [value, weight] of weights) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return weights[weights.length - 1]![0];
};

const MODELS = ["Opus 5.5", "Sonnet 5", "Haiku 4.5", "gpt-5.4"];

/** Builds the extra runners of a larger fleet. */
const buildRunners = (count: number): ReadonlyArray<RunnerInfo> => {
  const runners: RunnerInfo[] = [STUDIO_MAC, BUILD_BOX_1, BUILD_BOX_2];
  for (let index = 3; index < count; index++) {
    runners.push({
      id: `r-build-box-${index}`,
      name: `build-box-${index}`,
      slots: 24,
      local: false,
    });
  }
  return runners;
};

/**
 * Grows today's world to `total` colleagues on `runnerCount` runners: today's
 * colleagues stay, and generated sessions fill the rest, deterministically.
 */
const growWorld = (total: number, runnerCount: number): ReadonlyArray<Colleague> => {
  const random = createRandom(total * 7919 + runnerCount);
  const runners = buildRunners(runnerCount);
  const colleagues: Colleague[] = [...TODAY];
  const used = new Map<string, number>();
  for (let index = colleagues.length; index < total; index++) {
    const area = pickWeighted(random, AREA_WEIGHTS);
    const pose = pickWeighted(random, POSE_WEIGHTS);
    const titles = TITLES[area];
    const base = titles[Math.floor(random() * titles.length)]!;
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    const title = count === 1 ? base : `${base} (${String(count)})`;
    const id = `g-${String(index).padStart(4, "0")}`;
    const minutes = 1 + Math.floor(random() * 90);
    const runner = runners[3 + (index % Math.max(1, runners.length - 3))] ?? BUILD_BOX_2;
    const look: CrewLook = {
      hue: HUES[Math.floor(random() * HUES.length)]!,
      shape: SHAPES[Math.floor(random() * SHAPES.length)]!,
      accessories: WARDROBE[Math.floor(random() * WARDROBE.length)]!,
      headwear: null,
    };
    const waiting = pose === "waiting";
    colleagues.push({
      id,
      name: title,
      title,
      role: "session",
      look,
      pose,
      stateLabel:
        pose === "working"
          ? `${String(minutes)}m`
          : pose === "idle"
            ? `idle ${String(minutes)}m`
            : pose === "waiting"
              ? `waiting ${String(Math.min(minutes, 30))}m`
              : pose,
      project: AREA_PROJECT[area],
      area,
      runnerId: runner.id,
      model: MODELS[Math.floor(random() * MODELS.length)]!,
      activity: ["Reading the code", "Running the tests"],
      request: waiting
        ? {
            kind: "command",
            short: "Run pnpm install?",
            prompt: "pnpm install --frozen-lockfile",
            answers: ["Allow once", "Deny"],
            waitingMinutes: Math.min(minutes, 30),
          }
        : null,
      threadId: null,
    });
  }
  return colleagues;
};

/** Returns the world for a fleet size: today's 16 sessions, 48 colleagues, or the book's 10x. */
export function buildWorld(size: FleetSize): World {
  const colleagues =
    size === "today" ? TODAY : size === "growing" ? growWorld(48, 5) : growWorld(142, 9);
  const runnerCount = size === "today" ? 3 : size === "growing" ? 5 : 9;
  const projects: ReadonlyArray<ProjectKey> = ["webshop", "payments-api", "ops"];
  return {
    colleagues,
    runners: buildRunners(runnerCount),
    projects,
    proposals: size === "ten-x" ? { total: 60, burning: 4 } : { total: 5, burning: 1 },
    openTasks: size === "ten-x" ? 140 : 14,
    triage: { lastRun: "09:00", nextRun: "11:00" },
  };
}

/** Counts the colleagues per pose, as the top bar shows them. */
export function countPoses(world: World): Readonly<Record<Pose, number>> {
  const counts: Record<Pose, number> = {
    working: 0,
    waiting: 0,
    idle: 0,
    asleep: 0,
    paused: 0,
    failed: 0,
    done: 0,
    away: 0,
  };
  for (const colleague of world.colleagues) {
    if (colleague.role === "session" || colleague.role === "assistant") counts[colleague.pose]++;
  }
  return counts;
}
