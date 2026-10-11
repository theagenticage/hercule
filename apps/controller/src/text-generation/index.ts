/**
 * Text generation, as far as the domains need to know it: which model it runs
 * on now, and why the last call failed. The calls themselves are made by the
 * controller daemon, which owns the wire to the runners.
 */
export {
  AUTOMATIC_PROVIDER_ORDER,
  TextGenerationModels,
  TextGenerationModelsLayer,
  type TextGenerationChoice,
} from "./models";
export {
  LastTextGenerationFailure,
  LastTextGenerationFailureLayer,
  type TextGenerationFailure,
} from "./last-failure";
