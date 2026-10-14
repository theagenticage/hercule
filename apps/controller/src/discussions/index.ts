/**
 * Discussions: shared places where agent sessions post to each other about
 * one repository (spec 19). An Edit Overlap opens one through the service's
 * internal methods, or an agent or the user opens one on any subject.
 */
export {
  DiscussionService,
  DiscussionServiceLayer,
  type DiscussionPage,
  type OverlapFile,
  type QueryInput,
} from "./service";
