/**
 * What the add-account sheet decides (spec 17, Settings > Providers; spec 06
 * section 15.3): whether it asks for a kind and for a label, the steps a kind
 * needs, in order, and what each step's button does, the payload `providerAccount.create` takes, and the
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
 * What the primary button of a step does:
 *
 * - `next`: shows the next step;
 * - `create`: creates the account and finishes, because the account works
 *   once it exists (a key kind);
 * - `create-and-sign-in`: creates the account and shows the sign-in step,
 *   which needs the account to exist.
 */
type AddAccountSubmit = "next" | "create" | "create-and-sign-in";

/**
 * One step of the add-account sheet, after the provider and the kind are
 * chosen. Each step is one screen:
 *
 * - `credentials`: a masked field for each of `fields`, under the kind's own
 *   `instructions` (`null` when it has none);
 * - `label`: the label, asking `prompt`;
 * - `sign-in`: the harness login on a machine the user picks. Its button
 *   creates the account first when it does not exist yet.
 */
export type AddAccountStep =
  | {
      readonly kind: "credentials";
      readonly fields: ReadonlyArray<CredentialField>;
      readonly instructions: string | null;
      readonly submit: AddAccountSubmit;
    }
  | { readonly kind: "label"; readonly prompt: string; readonly submit: AddAccountSubmit }
  | { readonly kind: "sign-in"; readonly method: HarnessLoginMethod };

/**
 * Returns the steps of adding an account of `kind`, in order: its credentials
 * steps, then the label when `asksLabel`, then its sign-in steps. A harness-login
 * kind asks for its label before the sign-in, because `providerAccount.create`
 * needs the label and the sign-in needs the account. The `submit` of the last
 * step before the sign-in (or the last step, without one) creates the account.
 *
 * The kind's checklist steps are not steps of their own: their text, joined
 * in the order the kind declares it, is the `instructions` of each
 * credentials step. A step this sheet cannot draw (`oauth`, `device` and the
 * like) is left out: no shipped provider declares one.
 */
export const planAddAccountSteps = (
  kind: Pick<AccountKind, "setup">,
  asksLabel: boolean,
): ReadonlyArray<AddAccountStep> => {
  const instructions =
    kind.setup.flatMap((step) => (step.kind === "checklist" ? [step.markdown] : [])).join("\n\n") ||
    null;
  const questions = kind.setup.flatMap((step): Exclude<AddAccountStep, { kind: "sign-in" }>[] =>
    step.kind === "credentials"
      ? [{ kind: "credentials", fields: step.fields, instructions, submit: "next" }]
      : [],
  );
  if (asksLabel) {
    questions.push({
      kind: "label",
      prompt: "Give this one a name, so you can tell them apart.",
      submit: "next",
    });
  }
  const signIns = kind.setup.flatMap((step): AddAccountStep[] =>
    step.kind === "harness-login" ? [{ kind: "sign-in", method: step.method }] : [],
  );
  const lastSubmit: AddAccountSubmit = signIns.length === 0 ? "create" : "create-and-sign-in";
  return [
    ...questions.map((step, index) =>
      index === questions.length - 1 ? { ...step, submit: lastSubmit } : step,
    ),
    ...signIns,
  ];
};

/** What the user has typed into the sheet. */
export interface AddAccountDraft {
  readonly label: string;
  /** The credential fields' values, by field name. */
  readonly credentials: Readonly<Record<string, string>>;
}

/**
 * Checks that the user has filled in what `step` asks for: every field of a
 * `credentials` step, and a label for a `label` step (it is asked only when
 * the account needs a name). A `sign-in` step asks for nothing. Text of
 * nothing but spaces counts as empty.
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
