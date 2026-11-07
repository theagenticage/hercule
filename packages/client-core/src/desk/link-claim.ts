/**
 * The words for who says two things are linked. A pair of linked things shows
 * once, under its firmest claim, and every screen that draws a link (the
 * Inbox's tucked rows and hints, the open card's Linked section, Work's pane)
 * words that claim here, so they all agree.
 */
import type { EntityLink } from "@hercule/contract";
import { namePlugin, type PluginName } from "../intake";

/**
 * Returns the sentence for a link's claim, for a hover or a small label:
 *
 * - a `source` claim reads "Linear reports this", with the plugin's display
 *   name (its id when the plugin is not listed);
 * - a `person` claim reads "You linked this", because Hercule has one user;
 * - a `text` claim reads "Found in the description of OPS-47": the text the
 *   reference was found in (`claim.evidenceKey`) and, when `mentioner` is
 *   given, the identifier of the thing whose text it is. With no evidence key
 *   it reads "Found in the text".
 *
 * A `source` claim with no plugin reads "The source reports this".
 */
export const describeClaim = (
  claim: EntityLink["claim"],
  plugins: ReadonlyArray<PluginName>,
  mentioner?: string,
): string => {
  switch (claim.type) {
    case "person":
      return "You linked this";
    case "source":
      return `${claim.plugin === undefined ? "The source" : namePlugin(claim.plugin, plugins)} reports this`;
    case "text": {
      const place = claim.evidenceKey === undefined ? "the text" : `the ${claim.evidenceKey}`;
      return `Found in ${place}${mentioner === undefined ? "" : ` of ${mentioner}`}`;
    }
  }
};
