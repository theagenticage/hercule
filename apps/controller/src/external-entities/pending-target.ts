/**
 * The target of a claim that has no External Ref yet.
 *
 * A source can point at a thing it cannot name as a ref: a Linear link in a
 * GitHub description, an identifier such as `SHOP-123`, or a web address no
 * active plugin knows. The claim is kept anyway, with a pending target in
 * place of the ref, until a plugin's lookup can say which thing it is.
 *
 * A pending target is not an External Ref and must never reach a client. It
 * has two forms:
 *
 * - `unresolved:url:<url>` for a web address nothing recognized;
 * - `unresolved:<plugin>:<kind>:<scope>/<identifier>` for something a plugin
 *   recognized but cannot place without reading it. `<kind>` and `<scope>` are
 *   empty when the plugin did not say. Every component is written with
 *   `encodeURIComponent`, so none of them holds a `:` or a `/` and the form
 *   decodes back to exactly what was encoded.
 *
 * This file is the only place that builds or reads the two forms.
 */
import { isHttpUrl } from "@hercule/plugin-host";
import type { ScopedTarget } from "../plugins";

/** What every pending target starts with. The database column `is_pending` tests the same prefix. */
export const PENDING_TARGET_PREFIX = "unresolved:";

/** What the pending target of a web address starts with. */
export const PENDING_URL_PREFIX = `${PENDING_TARGET_PREFIX}url:`;

/** A pending target, as a plugin recognized it. */
export type PendingTarget =
  /** A web address that no active plugin recognized. */
  | { readonly form: "url"; readonly url: string }
  /** A thing a plugin recognized but could not place without reading it. */
  | ({ readonly form: "scoped" } & ScopedTarget);

/** Matches the scoped form after its prefix: four components, none holding a `:` or a `/`. */
const SCOPED_FORM = /^([^:/]+):([^:/]*):([^:/]*)\/([^:/]+)$/;

/** Returns true when `value` is a pending target and so is not an External Ref. */
export const isPendingTarget = (value: string): boolean => value.startsWith(PENDING_TARGET_PREFIX);

/**
 * Encodes a pending target. Returns undefined when it cannot be encoded: the
 * plugin id or the identifier is empty, or a component holds a lone surrogate
 * (`encodeURIComponent` refuses it). An empty `kind` or `scopeHint` means
 * absent.
 */
export const encodePendingTarget = (target: PendingTarget): string | undefined => {
  if (target.form === "url") return `${PENDING_URL_PREFIX}${target.url}`;
  if (target.pluginId === "" || target.identifier === "") return undefined;
  try {
    return (
      `${PENDING_TARGET_PREFIX}${encodeURIComponent(target.pluginId)}` +
      `:${encodeURIComponent(target.kind ?? "")}:${encodeURIComponent(target.scopeHint ?? "")}` +
      `/${encodeURIComponent(target.identifier)}`
    );
  } catch {
    return undefined;
  }
};

/**
 * Returns the start of every pending target that waits for the lookup of one
 * plugin: `unresolved:<plugin>:`. A pending target of a web address starts
 * with `PENDING_URL_PREFIX` instead, because no plugin is known for it yet.
 */
export const buildScopedTargetPrefix = (pluginId: string): string =>
  `${PENDING_TARGET_PREFIX}${encodeURIComponent(pluginId)}:`;

/**
 * Decodes a pending target written by `encodePendingTarget`. Returns undefined
 * for anything else, including an External Ref and a value that is malformed.
 */
export const decodePendingTarget = (value: string): PendingTarget | undefined => {
  if (!isPendingTarget(value)) return undefined;
  if (value.startsWith(PENDING_URL_PREFIX) && isHttpUrl(value.slice(PENDING_URL_PREFIX.length))) {
    return { form: "url", url: value.slice(PENDING_URL_PREFIX.length) };
  }
  const match = SCOPED_FORM.exec(value.slice(PENDING_TARGET_PREFIX.length));
  if (match === null) return undefined;
  try {
    const [pluginId, kind, scopeHint, identifier] = match
      .slice(1)
      .map((component) => decodeURIComponent(component)) as [string, string, string, string];
    return {
      form: "scoped",
      pluginId,
      ...(kind === "" ? {} : { kind }),
      ...(scopeHint === "" ? {} : { scopeHint }),
      identifier,
    };
  } catch {
    return undefined;
  }
};
