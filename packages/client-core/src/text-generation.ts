/**
 * Builds what Settings > System shows about text generation: the choices for
 * the `textGeneration.model` setting, and the line about the last failure.
 * The web app and the desktop app both read them from here, so neither screen
 * holds a rule of its own about what Automatic means or when a failure is
 * worth showing. The desktop's first run names the model with
 * `describeTextGenerationModel`, and the recap line of its last screen, All
 * set, is `describeTextGenerationRecap`.
 *
 * The controller decides which model Automatic resolves to and reports it in
 * `controller.read`. Nothing here repeats that rule.
 */
import type {
  Provider,
  ProviderAccount,
  TextGenerationModel,
  TextGenerationStatus,
} from "@hercule/contract";
import { describeAge } from "./threads/age";
import { describeAgent } from "./threads/model-name";

/** One entry of the model select: what the user reads, and the setting picking it stores. */
export interface TextGenerationChoice {
  /** A unique string for the select to hold; not a setting value. */
  readonly key: string;
  readonly label: string;
  readonly setting: TextGenerationModel;
}

/** The model select: its entries, and the key of the entry the stored setting selects. */
export interface TextGenerationField {
  readonly choices: readonly TextGenerationChoice[];
  readonly selectedKey: string;
}

/** A model from a Provider Account, as the setting stores it or the status reports it. */
type AccountModel = Exclude<TextGenerationModel, "automatic" | "off">;

/**
 * Returns the name of the model text generation runs on, such as
 * `OpenAI · GPT-6 Luna`. Falls back to the slug alone when the account is
 * gone, as `describeAgent` does.
 */
export const describeTextGenerationModel = (
  providers: readonly Provider[],
  accounts: readonly ProviderAccount[],
  model: AccountModel,
): string => {
  const account = accounts.find((each) => each.id === model.providerAccountId);
  return describeAgent(
    providers,
    account,
    model.harnessId ?? account?.defaultHarnessId ?? "",
    model.model,
  );
};

/** What the select and the recap read when Automatic found no model to run on. */
const NO_MODEL_AVAILABLE = "no model available";

/**
 * Returns the recap line of the desktop's All set: the name of the model that
 * text generation runs on, such as `OpenAI · GPT-6 Luna`, or "no model
 * available" when `status` holds none.
 */
export const describeTextGenerationRecap = (
  providers: readonly Provider[],
  accounts: readonly ProviderAccount[],
  status: TextGenerationStatus,
): string =>
  status.model === null
    ? NO_MODEL_AVAILABLE
    : describeTextGenerationModel(providers, accounts, status.model);

/**
 * Returns the key of the select entry for `model`. A setting that leaves the
 * harness out and one that names the account's default harness are the same
 * choice, so both give the same key.
 */
const buildModelKey = (accounts: readonly ProviderAccount[], model: AccountModel): string =>
  [
    model.providerAccountId,
    model.harnessId ??
      accounts.find((each) => each.id === model.providerAccountId)?.defaultHarnessId ??
      "",
    model.model,
  ].join("/");

/**
 * Returns the model select: Automatic first, then one entry per Provider
 * Account and model that is signed in on some runner in the account's default
 * harness, then Off. A model that a harness keeps only for old sessions
 * (`isLegacy`) is not offered, and a model several runners list appears once.
 *
 * Automatic names the model it resolves to only while it is the stored
 * setting. With any other setting, `status.model` is that setting's own model,
 * so it tells nothing about what Automatic would pick.
 *
 * A stored model that no signed-in account offers any more (the account was
 * deleted, or signed out) stays in the list as "(not offered)". The setting
 * is the user's choice and does not silently change; the controller reports
 * the failures it causes.
 */
export const buildTextGenerationField = (
  stored: TextGenerationModel | undefined,
  providers: readonly Provider[],
  accounts: readonly ProviderAccount[],
  status: TextGenerationStatus,
): TextGenerationField => {
  const setting = stored ?? "automatic";

  const describeAutomatic = (): string => {
    if (setting !== "automatic") return "Automatic";
    if (status.model === null) return `Automatic - ${NO_MODEL_AVAILABLE}`;
    return `Automatic - currently ${describeTextGenerationModel(providers, accounts, status.model)}`;
  };

  const offered: TextGenerationChoice[] = accounts.flatMap((account) => {
    const slugs = new Set(
      account.snapshots
        .filter(
          (snapshot) =>
            snapshot.harnessId === account.defaultHarnessId && snapshot.auth.status === "ok",
        )
        .flatMap((snapshot) => snapshot.models)
        .filter((model) => model.isLegacy !== true)
        .map((model) => model.slug),
    );
    return [...slugs].map((slug) => {
      const choice = { providerAccountId: account.id, model: slug };
      return {
        key: buildModelKey(accounts, choice),
        label: describeAgent(providers, account, account.defaultHarnessId, slug),
        setting: choice,
      };
    });
  });

  const selectedKey = typeof setting === "string" ? setting : buildModelKey(accounts, setting);

  if (typeof setting === "object" && !offered.some((choice) => choice.key === selectedKey)) {
    offered.push({
      key: selectedKey,
      label: `${describeTextGenerationModel(providers, accounts, setting)} (not offered)`,
      setting,
    });
  }

  return {
    choices: [
      { key: "automatic", label: describeAutomatic(), setting: "automatic" },
      ...offered,
      { key: "off", label: "Off", setting: "off" },
    ],
    selectedKey,
  };
};

const FAILURE_REASON_WORDS = {
  unavailable: "unavailable",
  failed: "failed",
  timeout: "timed out",
  "invalid-output": "invalid output",
} as const;

/**
 * Returns the line about the last failed text generation, such as
 * "Last failure 5 minutes ago - timed out: The model did not answer in time."
 * Returns null when there is nothing to show: no failure is known, or text
 * generation is off, because a failure from before it was turned off no
 * longer applies to the current setting.
 *
 * The line names no model. The status does not carry which model failed. It
 * does not need to: the controller returns a failure only while the setting
 * and the model it resolves to are the ones the failed call ran on, so the
 * line is always about the model shown beside it.
 */
export const describeTextGenerationFailure = (
  stored: TextGenerationModel | undefined,
  status: TextGenerationStatus,
  now: Date,
): string | null => {
  if (stored === "off" || status.lastFailure === null) return null;
  const { reason, message, at } = status.lastFailure;
  return `Last failure ${describeAge(at, now)} - ${FAILURE_REASON_WORDS[reason]}: ${message}`;
};
