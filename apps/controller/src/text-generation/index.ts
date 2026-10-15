/**
 * Text generation, as far as the domains need to know it: which model it runs
 * on now, why the last call failed, and the `TextGeneration` service that
 * makes a call. The controller daemon implements that service, because it owns
 * the wire to the runners.
 */
export {
  buildTextGenerationUnavailableReason,
  explainTextGenerationUnavailable,
  TextGenerationModels,
  TextGenerationModelsLayer,
  type TextGenerationTarget,
} from "./models";
export {
  LastTextGenerationFailure,
  LastTextGenerationFailureLayer,
  type TextGenerationFailure,
} from "./last-failure";
export {
  TextGeneration,
  TextGenerationError,
  type TextGenerationCall,
  type TextGenerationCaller,
} from "./service";
