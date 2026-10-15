/**
 * Edit Overlaps: records the files each session edited, and puts the
 * unfinished sessions that edited the same file of one repository into one
 * overlap Discussion (spec 19 section 4). The Discussions domain holds the
 * Discussions themselves.
 */
export { EditOverlapService, EditOverlapServiceLayer } from "./service";
