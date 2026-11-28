/**
 * The loop that gives pending claims a ref.
 *
 * A claim whose thing no plugin could place when it was reported (a Linear
 * link in a GitHub description, `SHOP-123` in a ticket, a web address nobody
 * knew) holds a pending target. This loop reads the thing through
 * `EntityLookups.resolve`, with the same rules as the Add button: never the
 * first match, and an ambiguous or incomplete answer leaves the claim pending.
 * Found rewrites the claim's target to the canonical ref and keeps its type
 * and Connection.
 *
 * Reading costs requests to the plugin's source, so the loop spends a budget
 * per plugin whose things are read (the target plugin), not per Connection
 * that reported the claim: `MAX_CLAIMS_PER_PLUGIN_PER_WINDOW` claims per
 * window, and a window is as long as the interval of the plugin's declared
 * `entities` feed. Recognizing a web address reads nothing and spends no budget.
 *
 * It runs here and not inside the plugin host because the host builds the
 * ingest loops and the lookups need the host. Lookups take seconds, so they
 * run outside any transaction, and each result is written in its own short one
 * (`ClaimResolution.settle`). The Connection that reported the claim is never
 * touched: a failed lookup says nothing about it.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import {
  buildScopedTargetPrefix,
  ClaimResolution,
  decodePendingTarget,
  encodePendingTarget,
  PENDING_URL_PREFIX,
  type ClaimResolutionOutcome,
  type PendingClaim,
} from "../../external-entities";
import {
  buildScopedRecognition,
  EntityLookups,
  findUrlTarget,
  PluginHost,
  type DecidedResolution,
  type RegisteredEventSource,
} from "../../plugins";
import { PromotionState } from "../../promotion";
import { nowIso } from "../../db";
import { absorbFailures } from "../../absorbing";

/** The most pending claims of one plugin's things that are read in one window. */
export const MAX_CLAIMS_PER_PLUGIN_PER_WINDOW = 20;

/**
 * The most pending web addresses one pass recognizes. Recognizing reads
 * nothing, but each answer is a write, so a pass stays short.
 */
const MAX_ADDRESSES_PER_PASS = 100;

/**
 * How long the loop waits between passes. A pass with nothing due is a few
 * indexed statements, and the shortest backoff of a claim is 120 seconds, so
 * a short wait costs almost nothing and keeps a new claim from waiting long
 * for its first try.
 */
const CLAIM_RESOLVER_INTERVAL: Duration.Duration = Duration.seconds(30);

/** The wait between passes. Tests override it with a shorter one. */
export const ClaimResolverInterval = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/ClaimResolverInterval",
  { defaultValue: (): Duration.Duration => CLAIM_RESOLVER_INTERVAL },
);

/**
 * When each plugin's current window ends, as milliseconds since the epoch.
 * The loop keeps it in memory, so a restart opens every window afresh.
 */
export type ReadWindows = Map<string, number>;

/**
 * Returns the length of the window of a source, in milliseconds: the default
 * interval of its `entities` feed, else of its shortest feed, because a lookup
 * is only declared by a source that reads entities.
 */
const computeWindowMs = (source: RegisteredEventSource): number => {
  const feeds = Object.values(source.feeds);
  const seconds =
    source.feeds["entities"]?.defaultIntervalSeconds ??
    Math.min(...feeds.map((feed) => feed.defaultIntervalSeconds));
  return seconds * 1000;
};

/**
 * Gives the pending web addresses that are due a target, without reading
 * anything. An address that a plugin recognizes as a ref becomes that ref,
 * one it recognizes as a scoped thing becomes a pending claim of that plugin,
 * and one nobody recognizes waits. Claims that hold the same address share one
 * answer.
 */
const recognizeAddresses = (now: string) =>
  Effect.gen(function* () {
    const resolution = yield* ClaimResolution;
    const lookups = yield* EntityLookups;
    const due = yield* Effect.orDie(
      resolution.listDue({
        now,
        targetPrefix: PENDING_URL_PREFIX,
        limit: MAX_ADDRESSES_PER_PASS,
      }),
    );

    const outcomes = new Map<string, ClaimResolutionOutcome | undefined>();
    const recognize = (url: string) =>
      Effect.gen(function* () {
        const target = findUrlTarget(yield* lookups.recognize(url));
        if (target === undefined) return undefined;
        if (target.recognized === "ref") {
          return { kind: "found", ref: target.ref } satisfies ClaimResolutionOutcome;
        }
        const encoded = encodePendingTarget({ ...target, form: "scoped" });
        return encoded === undefined
          ? undefined
          : ({ kind: "recognized", target: encoded } satisfies ClaimResolutionOutcome);
      });

    const postponed = new Set<string>();
    for (const claim of due) {
      const decoded = decodePendingTarget(claim.target);
      const url = decoded?.form === "url" ? decoded.url : undefined;
      if (url !== undefined && !outcomes.has(url)) outcomes.set(url, yield* recognize(url));
      const outcome = url === undefined ? undefined : outcomes.get(url);
      if (outcome !== undefined) {
        yield* Effect.orDie(
          resolution.settle({ claimId: claim.id, expectedTarget: claim.target, outcome }),
        );
      } else if (!postponed.has(claim.target)) {
        postponed.add(claim.target);
        yield* Effect.orDie(resolution.postponeTarget({ target: claim.target, now }));
      }
    }
  });

/**
 * Reads the due claims of one plugin's things, in the order given, and
 * settles them. The claims that hold one pending target are read once.
 *
 * - A thing the lookup found settles every claim that holds it.
 * - An answer that does not place the thing (not found, ambiguous, incomplete
 *   or unavailable) postpones every claim that holds the target, in one
 *   statement.
 * - An incomplete or unavailable answer also ends the pass of this plugin: a
 *   Connection failed or ran out of requests, so the next reads would fail
 *   the same way. Claims not yet read stay due and wait for the next window.
 */
const readPluginClaims = (pluginId: string, due: ReadonlyArray<PendingClaim>, now: string) =>
  Effect.gen(function* () {
    const resolution = yield* ClaimResolution;
    const lookups = yield* EntityLookups;
    const answers = new Map<string, DecidedResolution>();
    for (const claim of due) {
      const decoded = decodePendingTarget(claim.target);
      if (decoded?.form !== "scoped") {
        yield* Effect.orDie(resolution.postponeTarget({ target: claim.target, now }));
        continue;
      }
      let decided = answers.get(claim.target);
      if (decided === undefined) {
        decided = yield* lookups.resolve(pluginId, buildScopedRecognition(decoded));
        answers.set(claim.target, decided);
        if (!("found" in decided)) {
          yield* Effect.orDie(resolution.postponeTarget({ target: claim.target, now }));
        }
      }
      if ("found" in decided) {
        yield* Effect.orDie(
          resolution.settle({
            claimId: claim.id,
            expectedTarget: claim.target,
            outcome: { kind: "found", ref: decided.found.observation.ref },
          }),
        );
      } else if ("incomplete" in decided || "unavailable" in decided) {
        return;
      }
    }
  });

/**
 * Runs one pass: recognizes the pending web addresses that are due, then, for
 * each plugin whose window is open, reads up to
 * `MAX_CLAIMS_PER_PLUGIN_PER_WINDOW` due claims of its things. A plugin with
 * claims to read opens a window, just before its batch, that lasts the
 * interval of its `entities` feed (`windows` remembers when it ends); a
 * plugin with none keeps its window closed, so a claim that arrives later is
 * read at once.
 * Never fails on a lookup: an answer that does not place the thing postpones
 * the claim.
 */
export const resolvePendingClaims = (
  windows: ReadWindows = new Map(),
): Effect.Effect<void, never, ClaimResolution | EntityLookups | PluginHost> =>
  Effect.gen(function* () {
    const resolution = yield* ClaimResolution;
    const host = yield* PluginHost;
    yield* recognizeAddresses(yield* nowIso);

    const sources = (yield* host.listActiveEventSources()).filter(
      (source) => source.entityLookup !== undefined,
    );
    for (const source of sources) {
      const { pluginId } = source;
      // Read again for each plugin: the batches before this one may have taken minutes, and a window
      // opened with an earlier time would be over before this batch begins.
      const now = yield* nowIso;
      const nowMs = Date.parse(now);
      if ((windows.get(pluginId) ?? 0) > nowMs) continue;
      const due = yield* Effect.orDie(
        resolution.listDue({
          now,
          targetPrefix: buildScopedTargetPrefix(pluginId),
          limit: MAX_CLAIMS_PER_PLUGIN_PER_WINDOW,
        }),
      );
      if (due.length === 0) continue;
      windows.set(pluginId, nowMs + computeWindowMs(source));
      yield* readPluginClaims(pluginId, due, now);
    }
  });

/**
 * Resolves pending claims, then again after each `ClaimResolverInterval`.
 * Never returns. A pass that fails is logged, and the next one runs. A pass
 * runs only while the controller serves.
 *
 * Pending web addresses are made due again when the set of plugins that
 * recognize addresses changes, so an address nobody knew is read again as
 * soon as a plugin that knows it is enabled.
 */
export const runClaimResolverLoop: Effect.Effect<
  never,
  never,
  ClaimResolution | EntityLookups | PluginHost | PromotionState
> = Effect.gen(function* () {
  const resolution = yield* ClaimResolution;
  const lookups = yield* EntityLookups;
  const interval = yield* ClaimResolverInterval;
  const promotion = yield* PromotionState;
  const windows: ReadWindows = new Map();
  let knownLinkSources: string | undefined;
  while (true) {
    yield* absorbFailures(
      "Resolving pending claims failed",
      promotion.whenServing(
        Effect.gen(function* () {
          const linkSources = (yield* lookups.listLinkSources()).join(",");
          if (linkSources !== knownLinkSources) {
            knownLinkSources = linkSources;
            yield* Effect.orDie(resolution.makeUrlClaimsDue());
          }
          yield* resolvePendingClaims(windows);
        }),
      ),
    );
    yield* Effect.sleep(interval);
  }
});
