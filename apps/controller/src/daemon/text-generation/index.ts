/**
 * Text generation on the fleet: the `TextGeneration` service that picks a
 * runner, sends the call and writes its record.
 */
export {
  TextGeneration,
  TextGenerationError,
  type TextGenerationCaller,
  type TextGenerationRequest,
  type TextGenerationShape,
} from "./service";
