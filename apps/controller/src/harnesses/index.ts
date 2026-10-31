/**
 * Harnesses: the agent programs sessions run in. This domain holds what the
 * controller knows about a harness beyond its plugin's declaration: the
 * version this build was tested with, which spec fields it does not enforce,
 * and the `harness.query` listing.
 */
export { listUnenforcedFields } from "./enforcement";
export { HarnessService, HarnessServiceLayer } from "./service";
export { computeVersionVerdict, findVersionFloor } from "./version";
