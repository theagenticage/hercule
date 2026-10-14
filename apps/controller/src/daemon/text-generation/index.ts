/**
 * Text generation on the fleet: the layer that implements the
 * `TextGeneration` service of the text generation domain. It picks a runner,
 * sends the call and writes its record, and waits for a runner when the
 * caller asks it to.
 */
export { TextGenerationDeadline, TextGenerationLayer } from "./generate";
export {
  forwardTargetChanges,
  TextGenerationTargetChanges,
  TextGenerationTargetChangesLayer,
} from "./target-changes";
