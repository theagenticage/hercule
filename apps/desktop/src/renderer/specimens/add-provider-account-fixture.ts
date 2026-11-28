/**
 * The states of the add-account sheet that the specimen (add-provider-account.tsx)
 * draws. Each state is the props of `AddProviderAccountSheet` at one step,
 * built with the same `client-core` functions the app uses to decide the
 * steps, the label and the machines, so the specimen shows what the app shows.
 *
 * The machines are the Providers specimen's: studio-mac is this Mac and runs
 * Hercule, with Claude Code and Codex; atlas has Claude Code only; moss is
 * offline; old-box is retired and so is left out.
 */
import {
  buildProviderAccountName,
  listSignInRunnerOptions,
  planAddAccountSteps,
  type AddAccountStep,
} from "@hercule/client-core";
import { HARNESSES } from "@hercule/client-core/testing";
import type { AccountKind, Provider } from "@hercule/contract";
import { createElement } from "react";
import { ProviderMark, type AddProviderAccountSheetProps } from "../screens/settings/providers";
import {
  PROVIDERS_SIDEBAR_RECORDS,
  SPECIMEN_KINDS,
  SPECIMEN_PROVIDERS,
} from "./settings-providers-fixture";

const NO_OP = (): void => undefined;

const ANTHROPIC = SPECIMEN_PROVIDERS[0]!;
const ZAI = SPECIMEN_PROVIDERS[2]!;

const RUNNERS = PROVIDERS_SIDEBAR_RECORDS.runners;
const STUDIO_MAC_ID = "r-studio-mac";
const CLAUDE_CODE = HARNESSES.find((harness) => harness.id === "claude-code/claude-code")!;

const markOf = (provider: Provider, size: number) =>
  createElement(ProviderMark, {
    pluginId: provider.pluginId,
    plugins: PROVIDERS_SIDEBAR_RECORDS.plugins ?? [],
    size,
  });

/** The props of the sheet, as the specimen passes them. */
export type AddAccountSpecimenProps = Omit<AddProviderAccountSheetProps, "dialogRef" | "onClose">;

/** Returns the props of a sheet that draws `screen` under `provider`'s name, as every step after the first does. */
const buildStep = (
  provider: Provider,
  screen: AddAccountSpecimenProps["screen"],
  extra: Partial<AddAccountSpecimenProps> = {},
): AddAccountSpecimenProps => ({
  title: `Add ${provider.displayName}`,
  mark: markOf(provider, 16),
  screen,
  error: null,
  onBack: NO_OP,
  cancelLabel: "Cancel",
  primary: { label: "Continue", disabled: false, busy: false, onPress: NO_OP },
  ...extra,
});

/** Returns the sign-in screen for `steps`' `sign-in` step, with the controller's runner (studio-mac) first. */
const buildSignIn = (
  kind: AccountKind,
  steps: ReadonlyArray<AddAccountStep>,
): AddAccountSpecimenProps => {
  const step = steps.find((each) => each.kind === "sign-in");
  if (step === undefined) throw new Error(`${kind.id} has no sign-in step.`);
  const { options, defaultRunnerId } = listSignInRunnerOptions(
    RUNNERS,
    CLAUDE_CODE,
    step.method,
    STUDIO_MAC_ID,
  );
  const button = options.find((option) => option.runnerId === defaultRunnerId)!.buttonLabel;
  return buildStep(
    ANTHROPIC,
    {
      kind: "sign-in",
      method: step.method,
      options,
      chosenRunnerId: defaultRunnerId,
      signedInOn: null,
      onChoose: NO_OP,
    },
    // The account exists now, so there is no step to go back to, and leaving
    // discards it.
    {
      onBack: null,
      cancelLabel: "Discard",
      primary: { label: button, disabled: false, busy: false, onPress: NO_OP },
    },
  );
};

const KEY_STEPS = planAddAccountSteps(ZAI.kinds[0]!, false);

/**
 * Returns the key step of Z.ai, the last step before the account is created,
 * so its button is Done. `refusal` is the provider's refusal of the key, shown
 * under the field; `checking` is the step while the controller checks the key.
 */
const buildKeyStep = (refusal: string | null, checking = false): AddAccountSpecimenProps =>
  buildStep(
    ZAI,
    {
      kind: "credentials",
      lead: null,
      fields: KEY_STEPS.flatMap((step) => (step.kind === "credentials" ? step.fields : [])),
      values: { apiKey: "zai-sk-0123456789abcdef" },
      errors: refusal === null ? {} : { apiKey: refusal },
      busy: checking,
      onChange: NO_OP,
    },
    {
      primary: checking
        ? { label: "Checking the key…", disabled: false, busy: true, onPress: NO_OP }
        : { label: "Done", disabled: false, busy: false, onPress: NO_OP },
    },
  );
const SIGN_IN_STEPS = planAddAccountSteps(SPECIMEN_KINDS.perMachine!, true);
const TOKEN_STEPS = planAddAccountSteps(SPECIMEN_KINDS.token!, false);
const labelStep = SIGN_IN_STEPS.find((step) => step.kind === "label")!;

/** The states the specimen draws, by the name `?state=` gives. */
export const ADD_ACCOUNT_STATES: Readonly<Record<string, AddAccountSpecimenProps>> = {
  provider: {
    title: "Add an account",
    mark: null,
    screen: {
      kind: "provider",
      providers: SPECIMEN_PROVIDERS.map((provider) => ({
        id: provider.id,
        name: provider.displayName,
        mark: markOf(provider, 16),
      })),
      onPick: NO_OP,
    },
    error: null,
    onBack: null,
    cancelLabel: "Cancel",
    primary: null,
  },
  kind: buildStep(ANTHROPIC, {
    kind: "account-kind",
    kinds: ANTHROPIC.kinds.map(({ id, title, description }) => ({ id, title, description })),
    pickedId: SPECIMEN_KINDS.token!.id,
    onPick: NO_OP,
  }),
  key: buildKeyStep(null),
  "key-checking": buildKeyStep(null, true),
  "key-refused": buildKeyStep("Z.ai refused this key: token expired or incorrect."),
  label: buildStep(ANTHROPIC, {
    kind: "label",
    prompt: labelStep.prompt,
    value: "Work",
    placeholder: "Work, Personal, Team…",
    hint: `Shown after the provider, as in ${buildProviderAccountName(SPECIMEN_PROVIDERS, { providerId: ANTHROPIC.id, label: "Work" })}. It tells your accounts apart in menus.`,
    error: null,
    busy: false,
    onChange: NO_OP,
  }),
  "sign-in": buildSignIn(SPECIMEN_KINDS.perMachine!, SIGN_IN_STEPS),
  token: buildSignIn(SPECIMEN_KINDS.token!, TOKEN_STEPS),
};
