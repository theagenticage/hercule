/**
 * The words for the two ways a thing from a source can be out of the user's
 * reach (spec 20 section 1.3), so every screen, and the context block of a
 * prompt, says them the same way.
 */
import { lowerFirst } from "./strings";

/**
 * Returns the words for a restricted place, a thing no Connection can read,
 * such as "A Sentry error you cannot open". It names the kind of thing and
 * never its title, identifier or URL.
 *
 * `noun` is the kind's noun ("Error", "PR"); an empty or missing one reads as
 * "record". `pluginName` is the plugin's display name; leave it out where it
 * is not at hand, as in a prompt ("An error you cannot open"). The article
 * follows the first letter of the words, so it is "An Asana task" and "A
 * GitHub PR".
 */
export const describeRestrictedThing = (
  noun: string | null | undefined,
  pluginName?: string,
): string => {
  const kind = noun === null || noun === undefined || noun === "" ? "record" : lowerFirst(noun);
  const named = pluginName === undefined ? kind : `${pluginName} ${kind}`;
  return `${/^[aeiou]/i.test(named) ? "An" : "A"} ${named} you cannot open`;
};

/**
 * Returns the words that qualify the facts of a thing that lost access, or
 * `undefined` for a thing that can be read (`ok`, or no access given). The
 * facts are the last known ones, and the thing is not restricted. `deleted` is
 * worded as a fact only because a source said so for certain; any other lost
 * access means the user's Connections can no longer open the thing.
 */
export const describeLostAccess = (
  access: "ok" | "inaccessible" | "deleted" | undefined,
): string | undefined => {
  switch (access) {
    case "inaccessible":
      return "Last known state - you can no longer open it";
    case "deleted":
      return "Last known state - deleted at the source";
    case "ok":
    case undefined:
      return undefined;
  }
};
