/**
 * The Wiki: per repository, pages that agents write for the agents after
 * them, with every revision kept (spec 19 section 2.3).
 */
export { wikiPageRepository, type WikiDigest } from "./repository";
export {
  WikiPageService,
  WikiPageServiceLayer,
  type QueryInput,
  type ReadInput,
  type UpdateInput,
  type WikiPageListing,
} from "./service";
