/**
 * Intake settings: which of a plugin's event kinds triage may read and which
 * of its signal kinds are raised, at the plugin's level and at a Connection's.
 * This domain holds the rules and the interface; the plugins domain provides
 * the plugin's data.
 */
export { PluginIntake } from "./plugin-intake";
export {
  applyIntakeOverrides,
  buildDefaultIntakeSettings,
  normalizeIntakeOverrides,
  NO_INTAKE_OVERRIDES,
  type DeclaredEventKindIntake,
  type DeclaredIntakeKinds,
  type DeclaredSignalKindIntake,
} from "./settings";
