/**
 * Gives the short ids of the specimens' fixtures (`s-github`, `p-webshop`,
 * `c-linear`) the shape the controller gives every id, a UUIDv7, so that a
 * page that reads the fixtures through the client can decode them. The client
 * refuses any other id.
 *
 * The fixtures keep their short ids because a specimen that seeds its query
 * cache never decodes them, and many fixtures and specimens name each other's
 * ids as text.
 */

/** A fixture id: one of the entity letters, then a hyphen, such as `s-github` or `co-r-webshop-main`. */
const FIXTURE_ID = /^(?:[spracwt]|co)-/;

/** Checks whether the field `key` holds an id or a list of ids. */
const isIdField = (key: string): boolean => key === "id" || /(?:Id|Ids)$/.test(key);

/** Collects the fixture ids in the fields of `value` that hold ids, in the order they appear. */
function collectFixtureIds(value: unknown, key: string, found: Set<string>): void {
  if (typeof value === "string") {
    if (isIdField(key) && FIXTURE_ID.test(value)) found.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectFixtureIds(item, key, found);
  } else if (typeof value === "object" && value !== null) {
    for (const [field, item] of Object.entries(value)) collectFixtureIds(item, field, found);
  }
}

/** Replaces every string of `value` that is a key of `uuids` by its UUID, in a copy. */
function replaceIds(value: unknown, uuids: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return uuids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => replaceIds(item, uuids));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([field, item]) => [field, replaceIds(item, uuids)]),
    );
  }
  return value;
}

/**
 * Returns a function that converts what `world` names to UUIDv7 ids: the
 * fixture ids found in the fields of `world` that hold ids. The function
 * returns a copy of any value in which every string equal to one of those ids
 * is replaced by its UUID, and leaves every other string as it is. A string
 * that is an id in one field is the same id wherever it appears, so the
 * replacement covers the paths and the query values that name the same record.
 *
 * Each id gets the same UUID every time, in every run, so a capture is stable.
 */
export function buildFixtureIdConverter(world: unknown): <T>(value: T) => T {
  const found = new Set<string>();
  collectFixtureIds(world, "", found);
  const uuids = new Map(
    [...found].map((id, index) => [
      id,
      `01a1f6b0-0000-7000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
    ]),
  );
  return <T>(value: T): T => replaceIds(value, uuids) as T;
}
