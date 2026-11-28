/**
 * Initiatives: a lasting intent of the user's own, that Tasks belong to.
 *
 * An Initiative has a name, what it is for, an optional target, and a colour
 * of its own. A Task belongs to at most one (`Task.initiativeId`), whatever
 * its project. Work draws an Initiative as a line across the stages with one
 * bead per Task. Closing one hides it from Work and keeps its Tasks on it.
 * Delete is soft: a deleted Initiative is left out of every read, and its
 * Tasks lose it.
 *
 * Only the user creates, changes, closes, reopens and deletes an Initiative.
 * A session may put a Task on one that exists, through `task.update`.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { Id, Timestamp } from "../ids";
import { cursorParams, page } from "../pagination";
import { Authenticated } from "../security";
import { bounded } from "../strings";

/** The longest Initiative name. */
export const MAX_INITIATIVE_NAME_LENGTH = 200;

/** The longest intent. */
export const MAX_INITIATIVE_INTENT_LENGTH = 2000;

/** The longest target. A target is a line, such as "Live by the spring sale". */
export const MAX_INITIATIVE_TARGET_LENGTH = 200;

/**
 * The hues an Initiative's flag, line and beads are drawn in, as OKLCH hue
 * angles in degrees. They keep away from marigold and tomato, which mean
 * "needs you" and "failed" on Work. The order is the order a new Initiative
 * takes them in.
 */
export const INITIATIVE_HUES = [
  245, 150, 300, 200, 345, 118, 270, 175, 325, 222, 135, 100,
] as const;

export const InitiativeHue = Schema.Literals(INITIATIVE_HUES);

export type InitiativeHue = Schema.Schema.Type<typeof InitiativeHue>;

const InitiativeName = bounded(1, MAX_INITIATIVE_NAME_LENGTH);
const InitiativeIntent = bounded(0, MAX_INITIATIVE_INTENT_LENGTH);
const InitiativeTarget = bounded(1, MAX_INITIATIVE_TARGET_LENGTH);

export const Initiative = Schema.Struct({
  id: Id,
  name: InitiativeName,
  /** What this is for. */
  intent: InitiativeIntent,
  /** What finished looks like, when it is a goal. */
  target: Schema.optionalKey(InitiativeTarget),
  /** When the target is due. */
  targetDate: Schema.optionalKey(Timestamp),
  /** The hue of its flag, line and beads, from `INITIATIVE_HUES`. */
  hue: InitiativeHue,
  /**
   * The lane it draws in on Work. Absent, or a project that is no longer
   * listed: the No project lane. Its Tasks draw on its line whatever their
   * own project.
   */
  projectId: Schema.optionalKey(Id),
  /** Set when the user closes it. A closed Initiative keeps its Tasks, and Work stops drawing it. */
  closedAt: Schema.optionalKey(Timestamp),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type Initiative = Schema.Schema.Type<typeof Initiative>;

/**
 * The payload of `initiative.create`. The service decodes it too, so an
 * in-process caller must send the same shape as a request.
 */
export const InitiativeCreateInput = Schema.Struct({
  name: InitiativeName,
  /** Absent means an empty intent. */
  intent: Schema.optionalKey(InitiativeIntent),
  target: Schema.optionalKey(InitiativeTarget),
  targetDate: Schema.optionalKey(Timestamp),
  /** A project that exists; any other id fails `not_found`. */
  projectId: Schema.optionalKey(Id),
  /** Absent means the hue that the fewest open Initiatives use, the first in `INITIATIVE_HUES` on a tie. */
  hue: Schema.optionalKey(InitiativeHue),
});

export type InitiativeCreateInput = Schema.Schema.Type<typeof InitiativeCreateInput>;

/** The fields an Initiative update can change. */
const INITIATIVE_UPDATE_FIELDS = {
  name: Schema.optionalKey(InitiativeName),
  intent: Schema.optionalKey(InitiativeIntent),
  /** `null` removes the target. */
  target: Schema.optionalKey(Schema.NullOr(InitiativeTarget)),
  /** `null` removes the target date. */
  targetDate: Schema.optionalKey(Schema.NullOr(Timestamp)),
  /** `null` takes the Initiative out of its project's lane, into No project. */
  projectId: Schema.optionalKey(Schema.NullOr(Id)),
  hue: Schema.optionalKey(InitiativeHue),
};

/**
 * Rejects an Initiative update that sets no field. Such an update would still
 * change `updatedAt` and announce a change for nothing.
 */
export const refuseEmptyInitiativeUpdate = Schema.makeFilter(
  (update: { readonly [Field in keyof typeof INITIATIVE_UPDATE_FIELDS]?: unknown }) =>
    Object.keys(INITIATIVE_UPDATE_FIELDS).some(
      (field) => update[field as keyof typeof INITIATIVE_UPDATE_FIELDS] !== undefined,
    )
      ? undefined
      : "An initiative update must include at least one field to change. Add each field to change, such as name or target.",
);

/** The payload of `initiative.update`. A field left out is not changed, and at least one must be set. */
export const InitiativeUpdateInput = Schema.Struct(INITIATIVE_UPDATE_FIELDS).check(
  refuseEmptyInitiativeUpdate,
);

export type InitiativeUpdateInput = Schema.Schema.Type<typeof InitiativeUpdateInput>;

/**
 * The filters and paging of `initiative.query`. The list has one order,
 * creation order (`createdAt`, then `id`), so it takes no `sort`.
 */
export const InitiativeQuery = Schema.Struct({
  /** `true` lists the closed Initiatives instead of the open ones. Absent means `false`. */
  closed: Schema.optionalKey(Schema.Boolean),
  /** Lists only the Initiatives that draw in this project's lane. */
  projectId: Schema.optionalKey(Id),
  ...cursorParams.fields,
});

export type InitiativeQuery = Schema.Schema.Type<typeof InitiativeQuery>;

export const initiative = HttpApiGroup.make("initiative")
  .add(
    HttpApiEndpoint.get("query", "/initiatives", {
      query: InitiativeQuery,
      success: page(Initiative),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.get("read", "/initiatives/:id", {
      params: { id: Id },
      success: Initiative,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("create", "/initiatives", {
      payload: InitiativeCreateInput,
      success: Initiative,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.patch("update", "/initiatives/:id", {
      params: { id: Id },
      payload: InitiativeUpdateInput,
      success: Initiative,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    /** Closes an Initiative and returns it. Closing a closed one changes nothing. */
    HttpApiEndpoint.post("close", "/initiatives/:id/close", {
      params: { id: Id },
      success: Initiative,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    /** Reopens an Initiative and returns it. Reopening an open one changes nothing. */
    HttpApiEndpoint.post("reopen", "/initiatives/:id/reopen", {
      params: { id: Id },
      success: Initiative,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    /** Deletes an Initiative. Each of its Tasks loses it, with one `task.updated` each. */
    HttpApiEndpoint.delete("delete", "/initiatives/:id", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
  )
  .middleware(Authenticated);
