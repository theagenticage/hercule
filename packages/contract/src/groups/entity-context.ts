/**
 * The parts of an External Entity that Work and the Inbox share: a status, a
 * place above the cards, and the edges between places. They live apart from
 * `external-entity.ts` because `task.ts` (the Work board) reads them and
 * `external-entity.ts` reads `task.ts` (the stage a new Task starts at), and a
 * file that two files import in a circle would not load.
 *
 * An External Entity is a durable record of an outside thing. Its kind table,
 * its relation claims and its lifecycle are described in the ticket for the
 * Inbox (#1032) and in `external-entity.ts`.
 */
import {
  ENTITY_REASON_TONES,
  ENTITY_STATUS_SHAPES,
  ENTITY_STATUS_TONES,
  EntityProgress,
  PluginId,
} from "@hercule/plugin-host";
import { Schema } from "effect";
import { ExternalRef, Timestamp } from "../ids";
import { bounded } from "../strings";

/**
 * The most `part of` edges one reply carries. A client rebuilds every path
 * from a reply's ancestors, edges and places, so the edges are the reply's
 * second-largest list after its cards.
 */
export const MAX_GRAPH_EDGES = 2000;

/**
 * The most places one Work board carries. Each card brings at most its
 * repository-like home, and each edge at most one more place above it, so the
 * bound is the board's card limit plus `MAX_GRAPH_EDGES`.
 */
export const MAX_BOARD_PLACES = 3000;

/**
 * The most refs one Work card lists in `contextRefs`: the refs its Task links
 * and everything above them. A Task links a handful of things, and the walk up
 * stops at eight levels, so 64 holds a real card with room to spare. Past it,
 * the board is marked as having incomplete context rather than growing.
 */
export const MAX_CARD_CONTEXTS = 64;

/** The most entity marks one Work card shows. A card has room for three. */
export const MAX_ENTITY_MARKS = 3;

/**
 * The most groupings one Work board offers. A plugin declares a few kinds that
 * can group things, so 32 is more than the installed plugins can produce.
 */
export const MAX_BOARD_GROUPINGS = 32;

/**
 * Re-exported from the package plugins are written against, which owns the
 * fixed sets a kind table may use and the shape of progress, so a plugin and
 * this API agree on one spelling.
 */
export { ENTITY_REASON_TONES, ENTITY_STATUS_SHAPES, ENTITY_STATUS_TONES, EntityProgress };

/**
 * A status as a card draws it: one of the fixed shapes in one of the fixed
 * tones, with the plugin's word for it ("Changes requested"). It is copied
 * from the kind table when the entity is observed, so it reads well after the
 * plugin is gone.
 */
export const EntityStatus = Schema.Struct({
  shape: Schema.Literals(ENTITY_STATUS_SHAPES),
  tone: Schema.Literals(ENTITY_STATUS_TONES),
  label: bounded(1, 60),
  /** True for the usual state of the kind. A request shows a status shape only when it is not the norm. */
  norm: Schema.optionalKey(Schema.Boolean),
});

export type EntityStatus = Schema.Schema.Type<typeof EntityStatus>;

/**
 * A record above the cards, such as a repository or a project. It has no
 * card, so it holds only what it says about itself.
 *
 * `restricted` is true for a place or a relation target that no Connection of
 * the user can read. It then has no `title`, and its identifier and URL are
 * not sent at all: the row says "A Sentry issue you cannot open", from `noun`.
 * A title learned through someone else's read, such as an attachment's label,
 * is never used as the title.
 */
export const EntityPlace = Schema.Struct({
  ref: ExternalRef,
  /** The kind's qualified word, such as `linear/project`. */
  kind: Schema.String,
  noun: bounded(1, 40),
  /** The words for its kind, such as "Linear project", when the kind can group things. */
  caption: Schema.optionalKey(bounded(1, 60)),
  /** Absent when only the ref is known, or the thing is restricted. */
  title: Schema.optionalKey(bounded(1, 512)),
  status: Schema.optionalKey(EntityStatus),
  /** Only when the source reports it. */
  progress: Schema.optionalKey(EntityProgress),
  /** A date the source reports, for ordering places. */
  targetDate: Schema.optionalKey(Timestamp),
  restricted: Schema.Boolean,
});

export type EntityPlace = Schema.Schema.Type<typeof EntityPlace>;

/**
 * One current `part of` step: `fromRef` is part of `toRef`. A thing may have
 * many parents, so a reply lists every edge and the client rebuilds the paths.
 */
export const EntityEdge = Schema.Struct({ fromRef: ExternalRef, toRef: ExternalRef });

export type EntityEdge = Schema.Schema.Type<typeof EntityEdge>;

/**
 * The small mark a Work card shows for each kind of outside thing its Task
 * links: the plugin that owns the kind, and the kind's qualified word.
 */
export const EntityMark = Schema.Struct({ plugin: PluginId, kind: Schema.String });

export type EntityMark = Schema.Schema.Type<typeof EntityMark>;

/**
 * One way Work can group its cards: a kind that can be a lane or a filter and
 * has at least one place on the board, with the words for it ("Linear
 * project").
 */
export const EntityGrouping = Schema.Struct({
  kind: Schema.String,
  caption: bounded(1, 60),
});

export type EntityGrouping = Schema.Schema.Type<typeof EntityGrouping>;
