/**
 * The event kinds a trigger can name: the kinds the core declares, and the
 * kinds of every plugin that runs. `eventKind.query` answers this list, and
 * the check of a workflow reads the same list, so an editor never offers a
 * kind that a save refuses.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { DeclaredEventKind, Forbidden } from "@hercule/contract";
import { requireGrant } from "../actor";
import { EventKindCatalog, type NameableEventKind } from "./catalog";

/** The one event kind whose triggers carry a schedule. The Scheduler emits it. */
export const CRON_TICK_EVENT_KIND = "cron.tick";

/**
 * The kinds the core declares, as data. They are here and not in a plugin
 * because the core is their source: the Scheduler for `cron.tick`, and the
 * controller itself for the kinds about runs and tasks.
 */
const CORE_EVENT_KINDS: ReadonlyArray<NameableEventKind> = [
  {
    kind: CRON_TICK_EVENT_KIND,
    description: "The schedule of a cron trigger came due. The trigger names its schedule.",
  },
  { kind: "run.completed", description: "A run completed." },
  { kind: "run.failed", description: "A run failed." },
  {
    kind: "run.cancelled",
    description: "A run was cancelled. A cancellation is not a failure.",
  },
  { kind: "task.created", description: "A Task was created." },
  { kind: "task.updated", description: "A Task was changed." },
];

/**
 * Whether the core declares a kind. A trigger names a kind by its name alone,
 * so a plugin that declared one of these would make the name mean two things.
 */
export const isCoreEventKind = (kind: string): boolean =>
  CORE_EVENT_KINDS.some((coreKind) => coreKind.kind === kind);

const make = Effect.gen(function* () {
  const catalog = yield* EventKindCatalog;

  /** Every kind a trigger can name, ordered by kind. */
  const list = (): Effect.Effect<ReadonlyArray<NameableEventKind>> =>
    Effect.map(catalog.listActiveEventKinds(), (pluginKinds) =>
      [...CORE_EVENT_KINDS, ...pluginKinds].sort((left, right) =>
        left.kind.localeCompare(right.kind),
      ),
    );

  return {
    /**
     * Every kind a trigger can name, for a check made inside another
     * operation. It checks no grant: the operation that reads it has checked
     * its own.
     */
    list,

    /** Every kind a trigger can name, and whether it needs a Connection. */
    query: (): Effect.Effect<ReadonlyArray<DeclaredEventKind>, Forbidden> =>
      Effect.gen(function* () {
        yield* requireGrant("eventKind.query");
        return (yield* list()).map(({ kind, description, connectionType }) => ({
          kind,
          description,
          connectionRequired: connectionType !== undefined,
        }));
      }),
  };
});

/** The event kinds a trigger can name. */
export class EventKinds extends Context.Service<EventKinds, Effect.Success<typeof make>>()(
  "hercule/controller/events/EventKinds",
) {}

export const EventKindsLayer: Layer.Layer<EventKinds, never, EventKindCatalog> =
  Layer.effect(EventKinds)(make);
