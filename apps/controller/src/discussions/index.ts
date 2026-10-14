/**
 * Discussions: shared places where agent sessions post to each other about
 * one repository (spec 19). An Edit Overlap opens one through the service's
 * internal methods, or an agent or the user opens one on any subject. The
 * service also drafts the Discussion Input that tells a session what it has
 * not been told yet.
 */
export {
  describeDiscussionInputRefusal,
  type DiscussionInputRefusal,
} from "./discussion-input-text";
export {
  DiscussionService,
  DiscussionServiceLayer,
  type DiscussionInputDraft,
  type DiscussionPage,
  type OverlapFile,
  type QueryInput,
  type ToldMark,
} from "./service";
export { describeDiscussionsToSession } from "./session-description";
export { buildSystemPostText, type OverlapLink, type SystemPostChanges } from "./system-post-text";
