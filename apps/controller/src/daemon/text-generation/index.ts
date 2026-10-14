/**
 * Text generation on the fleet: the layer that implements the
 * `TextGeneration` service of the text-generation domain. It picks a runner,
 * sends the call and writes its record.
 */
export { TextGenerationDeadline, TextGenerationLayer } from "./generate";
