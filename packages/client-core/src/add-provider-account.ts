/**
 * What the add-account sheet decides (spec 17, Settings > Providers; spec 06
 * section 15.3): whether it asks for a kind and for a label, the order of the
 * steps a kind needs, the payload `providerAccount.create` takes, and the
 * machines a sign-in can run on. The sheet draws these and decides nothing.
 */
import type {
  AccountKind,
  Harness,
  Provider,
  ProviderAccount,
  ProviderAccountCreateInput,
  Runner,
} from "@hercule/contract";
import type { CredentialField } from "./connection-types";
import {
  decideMachineAction,
  type ProviderAccountMachineAction,
} from "./provider-account-machines";
import type { HarnessLoginMethod } from "./provider-accounts";
import { describeHarnessOnRunner } from "./provider-rows";

/** The question the label step asks, because an account is named only to tell it from another one at the same provider. */
export const ADD_ACCOUNT_LABEL_PROMPT = "Give this one a name, so you can tell them apart.";

/**
 * Checks whether the user picks one of several kinds of account at `provider`,
 * such as a Claude subscription or an API key. A provider with one kind
 * shows no picker: that kind is the one to add.
 */
export const offersKindChoice = (provider: Provider): boolean => provider.kinds.length > 1;

/**
 * Checks whether adding an account at `provider` asks for a label: when the
 * user has an account there already. The first account is named by its
 * provider alone (spec 06 section 15.3).
 */
export const asksForAccountLabel = (
  accounts: ReadonlyArray<Pick<ProviderAccount, "providerId">>,
  provider: Pick<Provider, "id">,
): boolean => accounts.some((account) => account.providerId === provider.id);

/**
 * One step of the add-account sheet, after the provider and the kind are
 * chosen:
 *
 * - `checklist`: the kind's own instructions, shown as written;
 * - `credentials`: a masked field for each of `fields`;
 * - `label`: the label, asking `prompt`;
 * - `create`: the moment `providerAccount.create` runs. It has no screen: the
 *   button of the step before it creates the account;
 * - `sign-in`: the harness login on a machine the user picks. It needs the
 *   account, so it comes after `create`.
 */
export type AddAccountStep =
  | { readonly kind: "checklist"; readonly markdown: string }
  | { readonly kind: "credentials"; readonly fields: ReadonlyArray<CredentialField> }
  | { readonly kind: "label"; readonly prompt: string }
  | { readonly kind: "create" }
  | { readonly kind: "sign-in"; readonly method: HarnessLoginMethod };

/**
 * Returns the steps of adding an account of `kind`, in order. The kind's own
 * steps come in the order it declares them, then the label when `asksLabel`,
 * then `create`, then the `sign-in` steps, which need the account to exist. So
 * a key kind ends in `create` (the sheet's Done), and a harness-login kind
 * asks for its label before the sign-in, because `providerAccount.create`
 * needs the label and the sign-in needs the account.
 *
 * A step this sheet cannot draw (`oauth`, `device` and the like) is left out:
 * no shipped provider declares one.
 */
export const planAddAccountSteps = (
  kind: Pick<AccountKind, "setup">,
  asksLabel: boolean,
): ReadonlyArray<AddAccountStep> => {
  const declared = kind.setup.flatMap((step): AddAccountStep[] => {
    switch (step.kind) {
      case "checklist":
        return [{ kind: "checklist", markdown: step.markdown }];
      case "credentials":
        return [{ kind: "credentials", fields: step.fields }];
      case "harness-login":
        return [{ kind: "sign-in", method: step.method }];
      default:
        return [];
    }
  });
  const label: AddAccountStep[] = asksLabel
    ? [{ kind: "label", prompt: ADD_ACCOUNT_LABEL_PROMPT }]
    : [];
  return [
    ...declared.filter((step) => step.kind !== "sign-in"),
    ...label,
    { kind: "create" },
    ...declared.filter((step) => step.kind === "sign-in"),
  ];
};

/**
 * Checks whether the step after the one at `index` is `create`, so the
 * button of the step at `index` creates the account before it moves on.
 */
export const createsAccountAfterStep = (
  steps: ReadonlyArray<AddAccountStep>,
  index: number,
): boolean => steps[index + 1]?.kind === "create";

/** What the user has typed into the sheet. */
export interface AddAccountDraft {
  readonly label: string;
  /** The credential fields' values, by field name. */
  readonly credentials: Readonly<Record<string, string>>;
}

/**
 * Checks that the user has filled in what `step` asks for: every field of a
 * `credentials` step, and a label for a `label` step (it is asked only when
 * the account needs a name). Other steps ask for nothing. Text of nothing
 * but spaces counts as empty.
 */
export const isAddAccountStepFilled = (step: AddAccountStep, draft: AddAccountDraft): boolean => {
  if (step.kind === "label") return draft.label.trim() !== "";
  if (step.kind === "credentials") {
    return step.fields.every((field) => (draft.credentials[field.name] ?? "").trim() !== "");
  }
  return true;
};

/**
 * Returns the payload of `providerAccount.create` for the steps and what the
 * user typed. A pasted credential often has a stray space or newline, which
 * the provider would treat as a different credential, so values are trimmed.
 * `credentials` and `label` are in the payload only when their step is among
 * `steps`.
 */
export const buildProviderAccountCreateInput = (
  providerId: string,
  kindId: string,
  steps: ReadonlyArray<AddAccountStep>,
  draft: AddAccountDraft,
): ProviderAccountCreateInput => {
  const credentialFields = steps.flatMap((step) =>
    step.kind === "credentials" ? step.fields : [],
  );
  return {
    providerId,
    kind: kindId,
    ...(steps.some((step) => step.kind === "label") ? { label: draft.label.trim() } : {}),
    ...(credentialFields.length === 0
      ? {}
      : {
          credentials: Object.fromEntries(
            credentialFields.map((field) => [
              field.name,
              (draft.credentials[field.name] ?? "").trim(),
            ]),
          ),
        }),
  };
};

/** One machine the sign-in of the new account can run on. */
export interface SignInRunnerOption {
  readonly runnerId: string;
  readonly runnerName: string;
  /** Whether this is the runner on the machine that runs the controller. */
  readonly isController: boolean;
  /** What the machine offers; `reason` explains an action that cannot be pressed. */
  readonly action: ProviderAccountMachineAction;
  /** The label of the button that runs `action`, such as "Sign in", "Make the token" or "Install". */
  readonly buttonLabel: string;
}

/** The machines a sign-in can run on, and the one to start on. */
export interface SignInRunnerChoice {
  /** Every runner that is not retired, the controller's runner first, the others in the order given. */
  readonly options: ReadonlyArray<SignInRunnerOption>;
  /**
   * The first machine that can sign in now, else the first that can install
   * the harness, or `null` when there is neither.
   */
  readonly defaultRunnerId: string | null;
}

/**
 * Returns the machines the `method` login of `harness` can run on. A machine
 * with the harness signs in; one without it that has an adapter for it
 * installs it first; an offline machine, or one whose build cannot drive the
 * harness, cannot do either, and says why. `controllerRunnerId` is the runner
 * on the machine that runs the controller, or `null` when none is known: it
 * comes first, because that machine is the one the user is sitting at in the
 * first run.
 */
export const listSignInRunnerOptions = (
  runners: ReadonlyArray<Runner>,
  harness: Harness,
  method: HarnessLoginMethod,
  controllerRunnerId: string | null,
): SignInRunnerChoice => {
  const signInLabel = method === "create-token" ? "Make the token" : "Sign in";
  const options = runners
    .filter((runner) => runner.lifecycle !== "retired")
    .map((runner): SignInRunnerOption => {
      const { adapter, present, reachable } = describeHarnessOnRunner(runner, harness);
      const action = decideMachineAction(
        runner,
        {
          signIn: reachable && present && adapter,
          install: reachable && !present && adapter ? "offered" : "none",
        },
        harness.displayName,
      );
      return {
        runnerId: runner.id,
        runnerName: runner.name,
        isController: runner.id === controllerRunnerId,
        action,
        buttonLabel: action.kind === "install" ? "Install" : signInLabel,
      };
    });
  const ordered = [
    ...options.filter((option) => option.isController),
    ...options.filter((option) => !option.isController),
  ];
  return {
    options: ordered,
    defaultRunnerId:
      (
        ordered.find((option) => option.action.kind === "sign-in") ??
        ordered.find((option) => option.action.kind === "install")
      )?.runnerId ?? null,
  };
};
