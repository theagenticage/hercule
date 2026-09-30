/**
 * The event kinds a trigger can listen for: the platform event kinds plus the
 * kinds of every running plugin. `eventKind.query` returns this list, and
 * workflow validation reads the same list. So the editor never offers a kind
 * that a save then rejects.
 *
 * `cron.tick` is not in the list. The core emits it, so no plugin can declare
 * it, but no trigger can listen for it either: a trigger fires on a schedule
 * by writing the schedule under `on`.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { DeclaredEventKind, Forbidden } from "@hercule/contract";
import { requireGrant } from "../actor";
import { EventKindCatalog, type DeclaredEventKindWithConnectionType } from "./catalog";
import type { PlatformEventKind } from "./platform-events";

/**
 * The kind of the event the Scheduler emits when a cron trigger's schedule
 * comes due. A cron trigger's row stores it as the trigger's event kind, so
 * the event router delivers each tick to the one trigger the tick names.
 */
export const CRON_TICK_EVENT_KIND = "cron.tick";

/**
 * The description of each platform event kind. The record's type names every
 * kind the controller emits, so a kind cannot be emitted without being in the
 * catalog, where a trigger can name it.
 */
const PLATFORM_EVENT_DESCRIPTIONS: Record<PlatformEventKind, string> = {
  "run.completed": "A run completed.",
  "run.failed": "A run failed.",
  "run.cancelled": "A run was cancelled. A cancellation is not a failure.",
  "task.created": "A Task was created.",
  "task.updated": "A Task was changed.",
};

/** The platform event kinds, which a trigger can listen for. The controller emits them. */
const PLATFORM_EVENT_KINDS: ReadonlyArray<DeclaredEventKindWithConnectionType> = Object.entries(
  PLATFORM_EVENT_DESCRIPTIONS,
).map(([kind, description]) => ({ kind, description }));

/**
 * Returns true if the core emits events of `kind`: `cron.tick` or a platform
 * event kind. A plugin must not declare a kind that has a core kind's name,
 * because an event's kind is its name only, and the two kinds could not be
 * told apart.
 */
export const isCoreEventKind = (kind: string): boolean =>
  kind === CRON_TICK_EVENT_KIND || Object.hasOwn(PLATFORM_EVENT_DESCRIPTIONS, kind);

const make = Effect.gen(function* () {
  const catalog = yield* EventKindCatalog;

  const list = (): Effect.Effect<ReadonlyArray<DeclaredEventKindWithConnectionType>> =>
    Effect.map(catalog.listActiveEventKinds(), (pluginKinds) =>
      [...PLATFORM_EVENT_KINDS, ...pluginKinds].sort((left, right) =>
        left.kind.localeCompare(right.kind),
      ),
    );

  return {
    /**
     * Returns every kind a trigger can listen for, sorted by kind. Checks no
     * grant, because it is called inside another operation that has already
     * checked its own grant.
     */
    list,

    /**
     * Returns every kind a trigger can listen for, and whether it needs a
     * Connection. Fails with `Forbidden` if the caller lacks the
     * `eventKind.query` grant.
     */
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

/** The service that lists the event kinds a trigger can listen for. */
export class EventKinds extends Context.Service<EventKinds, Effect.Success<typeof make>>()(
  "hercule/controller/events/EventKinds",
) {}

export const EventKindsLayer: Layer.Layer<EventKinds, never, EventKindCatalog> =
  Layer.effect(EventKinds)(make);
