/**
 * The add-account flow: it drives `AddProviderAccountSheet` through the steps
 * `client-core` plans for the chosen provider and kind, creates the account
 * (`providerAccount.create`) and, for a kind that signs in through its
 * harness, runs the sign-in that makes it work (spec 17, Settings >
 * Providers, the add-account sheet). Settings opens it from the header's
 * "Add an account", and the first run's providers step opens it too.
 *
 * It is loaded on demand, from the first time a user opens it, so the code of
 * the sheet is not part of the first screen's scripts (spec 17 section
 * Performance). Import it only with `import()`.
 */
import { useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  addModelProfileAccount,
  asksForAccountLabel,
  buildProviderAccountCreateInput,
  buildProviderAccountName,
  findOpenModelProfile,
  isAddAccountStepFilled,
  isNotFound,
  listSignInRunnerOptions,
  offersKindChoice,
  planAddAccountSteps,
  queryKeys,
  readConfigIssues,
  readErrorMessage,
  updateModelProfile,
  type AddAccountDraft,
  type HerculeClient,
} from "@hercule/client-core";
import type { ProviderAccount, ProviderAccountCreateInput } from "@hercule/contract";
import {
  controllerQuery,
  harnessesQuery,
  modelProfilesQuery,
  pluginsQuery,
  providerAccountsQuery,
  providersQuery,
  runnersQuery,
} from "../../../app/queries";
import { ProviderLoginDialog } from "../../provider-login";
import {
  AddProviderAccountSheet,
  type AddAccountPrimaryButton,
  type AddProviderAccountScreen,
} from "./add-provider-account-sheet";
import { ProviderMark } from "./provider-mark";

/** Where the flow is: choosing a provider, choosing a kind, or on a screen of the kind's steps. */
type Stage =
  | { readonly at: "provider" }
  | { readonly at: "kind" }
  | { readonly at: "step"; readonly index: number };

/**
 * Renders the add-account sheet and everything behind its buttons.
 *
 * - A key kind creates its account at Done, with the key in the same request.
 *   The controller checks the key first and stores nothing when it refuses it,
 *   so its message shows under the key field and the typed key stays.
 * - While the account is being created, or a harness is being installed, the
 *   sheet cannot be left: its buttons, Esc and the scrim do nothing, so no
 *   account is made after the user thought they had cancelled.
 * - A kind that signs in through its harness creates the account at the button
 *   of the step before the sign-in (the label, when asked), and then asks which
 *   machine to sign in on. A machine's button opens the sign-in dialog, which
 *   is the one the account's sheet opens. A machine without the harness
 *   installs it first, from the same button, and then the dialog opens. Done
 *   closes the sheet once the sign-in has succeeded.
 * - Closing the sheet before the sign-in succeeded discards the account it
 *   created, with `providerAccount.delete`. A delete that fails reopens the
 *   sheet and shows why, so a half-made account never stays unseen.
 *
 * `signInMachines` says which machines a sign-in can run on: `"controller"` is
 * only the machine that runs the controller, as the first run offers it, and
 * `"all"` is every runner that is not retired. `client` is the client of the
 * controller the account is added to. It is passed in because the first run
 * renders this outside the routes that hold a saved controller.
 *
 * An account that stays is added to the Model Profile `modelProfileId`, with
 * its provider's Default Selection (`modelProfile.update`), so its models
 * reach the composer's menu. Settings passes the profile that is open on
 * Models. With no id, or an id of a profile that is gone, the account joins
 * the first profile, as it does in the first run. The sheet
 * stays open, with the controller's message, when that write fails, and Done
 * tries it again without making the account twice.
 *
 * `onAdded` is called with the account once it stays and is in the profile,
 * just before `onClose`. `onClose` is called once the sheet is gone: after
 * Done, after a close that keeps nothing, and after a discard. The caller then
 * unmounts it. The new account reaches the page through the accounts read,
 * which this refreshes and the `provider` live topic keeps current.
 */
export function AddProviderAccount({
  client,
  signInMachines,
  modelProfileId,
  onAdded,
  onClose,
}: {
  readonly client: HerculeClient;
  readonly signInMachines: "controller" | "all";
  readonly modelProfileId?: string | undefined;
  readonly onAdded?: (account: ProviderAccount) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const providers = useSuspenseQuery(providersQuery(client)).data;
  const accounts = useSuspenseQuery(providerAccountsQuery(client)).data;
  const harnesses = useSuspenseQuery(harnessesQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const controllerRunnerId = useSuspenseQuery(controllerQuery(client)).data.localRunnerId;

  const [stage, setStage] = useState<Stage>({ at: "provider" });
  const [providerId, setProviderId] = useState<string | null>(null);
  const [kindId, setKindId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AddAccountDraft>({ label: "", credentials: {} });
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [pickedRunnerId, setPickedRunnerId] = useState<string | null>(null);
  const [loginRunnerId, setLoginRunnerId] = useState<string | null>(null);
  const [signedInRunnerId, setSignedInRunnerId] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (input: ProviderAccountCreateInput) =>
      client.providerAccount.create({ payload: input }),
    // The sign-in dialog and the card read the account from the cache, so it
    // is there before anything that needs it opens.
    onSuccess: async (account) => {
      setCreatedId(account.id);
      const { queryKey } = providerAccountsQuery(client);
      queryClient.setQueryData(queryKey, (list) =>
        list === undefined || list.some(({ id }) => id === account.id) ? list : [...list, account],
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.providerAccounts() });
    },
  });
  const install = useMutation({
    mutationFn: (target: { readonly runnerId: string; readonly harnessId: string }) =>
      client.runner.installHarness({
        params: { id: target.runnerId },
        payload: { harnessId: target.harnessId },
      }),
    // The machine's row offers the sign-in once the runner's facts show the harness.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.runners() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.harnesses() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providerAccounts() }),
      ]),
  });
  const addToProfile = useMutation({
    mutationFn: async (account: ProviderAccount) => {
      const profile = findOpenModelProfile(
        await queryClient.ensureQueryData(modelProfilesQuery(client)),
        modelProfileId,
      );
      if (profile === undefined) return;
      const saved = await updateModelProfile(client, profile, (current) =>
        addModelProfileAccount(current, account.id),
      );
      queryClient.setQueryData(modelProfilesQuery(client).queryKey, (list) =>
        list?.map((each) => (each.id === saved.id ? saved : each)),
      );
    },
    // The dialog closed to start the write; it opens again to say it failed.
    onError: () => {
      dialogRef.current?.showModal();
    },
  });
  const discard = useMutation({
    // An account already gone is as good as deleted.
    mutationFn: async (account: ProviderAccount) => {
      try {
        await client.providerAccount.delete({ params: { id: account.id } });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
    onSuccess: async (_none, account) => {
      const { queryKey } = providerAccountsQuery(client);
      queryClient.setQueryData(queryKey, (list) => list?.filter(({ id }) => id !== account.id));
      await queryClient.invalidateQueries({ queryKey });
      onClose();
    },
    // The dialog closed to start the discard; it opens again to say it failed.
    onError: () => {
      dialogRef.current?.showModal();
    },
  });

  const provider = providers.find(({ id }) => id === providerId) ?? null;
  const kind = provider?.kinds.find(({ id }) => id === kindId) ?? null;
  // The account made by this flow does not count, or the label step would
  // appear halfway through.
  const asksLabel =
    provider !== null &&
    asksForAccountLabel(
      accounts.filter(({ id }) => id !== createdId),
      provider,
    );
  const steps = kind === null ? [] : planAddAccountSteps(kind, asksLabel);
  const created = accounts.find(({ id }) => id === createdId);

  // Editing a field clears the last create's failure so the form can be sent
  // again. While a create runs the fields are read-only, and a reset here
  // would drop `isPending` and unlock the sheet under a request still running.
  const changeDraft = (change: Partial<AddAccountDraft>): void => {
    if (create.isPending) return;
    create.reset();
    setDraft((current) => ({ ...current, ...change }));
  };
  const goTo = (next: Stage): void => {
    create.reset();
    setStage(next);
  };
  const pickProvider = (id: string): void => {
    const picked = providers.find((each) => each.id === id);
    if (picked === undefined) return;
    setProviderId(id);
    setDraft((current) => ({ ...current, credentials: {} }));
    if (offersKindChoice(picked)) {
      setKindId(null);
      goTo({ at: "kind" });
    } else {
      setKindId(picked.kinds[0]?.id ?? null);
      goTo({ at: "step", index: 0 });
    }
  };
  const pickKind = (id: string): void => {
    create.reset();
    setKindId(id);
    setDraft((current) => ({ ...current, credentials: {} }));
  };

  /** Puts `account`, which stays, in the profile, then tells the caller and closes. */
  const keepAccount = (account: ProviderAccount): void => {
    addToProfile.mutate(account, {
      onSuccess: () => {
        onAdded?.(account);
        onClose();
      },
    });
  };

  /**
   * Tries once to put `account`, which stays, in the profile, and closes the
   * sheet whether that works or not, so a failing profile never traps the user.
   * An account that did not join stays out of the profile; it can be added later.
   */
  const closeKeepingAccount = (account: ProviderAccount): void => {
    addToProfile.mutate(account, {
      onSuccess: () => {
        onAdded?.(account);
        onClose();
      },
      onError: onClose,
    });
  };

  /** Creates the account from what the user typed, then calls `afterCreate` with it. */
  const createAccount = (afterCreate: (account: ProviderAccount) => void): void => {
    if (provider === null || kind === null) return;
    create.mutate(buildProviderAccountCreateInput(provider.id, kind.id, steps, draft), {
      onSuccess: afterCreate,
    });
  };

  // Machines the sign-in can run on. Before the account exists, the
  // provider's own harness is the one the account will start with.
  const harness = harnesses.find(
    ({ id }) => id === (created?.defaultHarnessId ?? provider?.defaultHarnessId),
  );
  const signInStep = steps.find((step) => step.kind === "sign-in");
  const signInChoice =
    harness === undefined || signInStep?.kind !== "sign-in"
      ? null
      : listSignInRunnerOptions(
          signInMachines === "controller"
            ? runners.filter(({ id }) => id === controllerRunnerId)
            : runners,
          harness,
          signInStep.method,
          controllerRunnerId,
        );
  const chosenRunnerId = pickedRunnerId ?? signInChoice?.defaultRunnerId ?? null;
  const chosenOption = signInChoice?.options.find(({ runnerId }) => runnerId === chosenRunnerId);
  const signedInOn = runners.find(({ id }) => id === signedInRunnerId)?.name ?? null;

  /** Opens the sign-in dialog on the machine chosen now. */
  const startSignIn = (): void => {
    setLoginRunnerId(chosenRunnerId);
  };
  /**
   * Installs the harness on the machine when it lacks it, then creates the
   * account if it does not exist yet, then opens the sign-in. Installing here
   * keeps the sign-in dialog from asking for the install a second time.
   */
  const pressSignIn = (): void => {
    const proceed = (): void => {
      if (created === undefined) createAccount(startSignIn);
      else startSignIn();
    };
    if (
      chosenOption?.action.kind === "install" &&
      chosenRunnerId !== null &&
      harness !== undefined
    ) {
      install.mutate({ runnerId: chosenRunnerId, harnessId: harness.id }, { onSuccess: proceed });
    } else {
      proceed();
    }
  };

  const stepIndex = stage.at === "step" ? stage.index : 0;
  const step = stage.at === "step" ? steps[stepIndex] : undefined;

  // A refused key shows under its field. Any other failure of the create has
  // no field to sit under, so it shows in the sheet. That includes a refused
  // key when the create was sent from a later screen, such as the label
  // step, where the key field is not drawn.
  const createIssues = readConfigIssues(
    create.error,
    step?.kind === "credentials" ? step.fields : [],
    "credentials",
  );

  // The sheet draws no spinner, so the button says what is running. A key is
  // checked with its provider before it is stored, which can take a moment.
  const creatingLabel = steps.some((step) => step.kind === "credentials")
    ? "Checking the key…"
    : "Adding…";

  let body: AddProviderAccountScreen;
  let primary: AddAccountPrimaryButton | null = null;
  if (stage.at === "provider" || provider === null) {
    body = {
      kind: "provider",
      providers: providers.map((each) => ({
        id: each.id,
        name: each.displayName,
        mark: <ProviderMark pluginId={each.pluginId} plugins={plugins} size={16} />,
      })),
      onPick: pickProvider,
    };
  } else if (stage.at === "kind" || step === undefined) {
    body = {
      kind: "account-kind",
      kinds: provider.kinds.map(({ id, title, description }) => ({ id, title, description })),
      pickedId: kindId,
      onPick: pickKind,
    };
    primary = {
      label: "Continue",
      disabled: kindId === null,
      busy: false,
      onPress: () => goTo({ at: "step", index: 0 }),
    };
  } else if (step.kind === "sign-in") {
    body = {
      kind: "sign-in",
      method: step.method,
      options: signInChoice?.options ?? [],
      chosenRunnerId,
      signedInOn,
      onChoose: (runnerId) => {
        install.reset();
        setPickedRunnerId(runnerId);
      },
    };
    primary =
      signedInRunnerId === null
        ? {
            label: install.isPending
              ? "Installing…"
              : create.isPending
                ? creatingLabel
                : (chosenOption?.buttonLabel ?? "Sign in"),
            // An offline machine, or one whose build cannot run the harness, can do nothing.
            disabled:
              chosenOption === undefined ||
              (chosenOption.action.kind !== "sign-in" && chosenOption.action.kind !== "install"),
            busy: create.isPending || install.isPending,
            onPress: pressSignIn,
          }
        : {
            label: addToProfile.isPending ? "Adding…" : "Done",
            disabled: false,
            busy: addToProfile.isPending,
            onPress: () => {
              if (created !== undefined) keepAccount(created);
            },
          };
  } else {
    body =
      step.kind === "credentials"
        ? {
            kind: "credentials",
            lead: step.instructions,
            fields: step.fields,
            values: draft.credentials,
            errors: createIssues.perField,
            busy: create.isPending,
            onChange: (name, value) =>
              changeDraft({ credentials: { ...draft.credentials, [name]: value } }),
          }
        : {
            kind: "label",
            prompt: step.prompt,
            value: draft.label,
            placeholder: "Work, Personal, Team…",
            hint: `Shown after the provider, as in ${buildProviderAccountName(providers, { providerId: provider.id, label: "Work" })}. It tells your accounts apart in menus.`,
            error: null,
            busy: create.isPending,
            onChange: (label) => changeDraft({ label }),
          };
    primary = {
      label: addToProfile.isPending
        ? "Adding…"
        : create.isPending
          ? creatingLabel
          : step.submit === "create"
            ? "Done"
            : "Continue",
      disabled: !isAddAccountStepFilled(step, draft),
      busy: create.isPending || addToProfile.isPending,
      onPress: () => {
        const showNext = (): void => goTo({ at: "step", index: stepIndex + 1 });
        if (step.submit === "next") showNext();
        else if (step.submit !== "create") createAccount(showNext);
        // A key account that was made but could not join the profile is not made again.
        else if (created !== undefined) keepAccount(created);
        else createAccount(keepAccount);
      },
    };
  }

  // Back is for choices the user can still change; the account exists once
  // the sign-in screen is reached, so nothing is left to go back to.
  const previousStage: Stage | null =
    created !== undefined || stage.at === "provider"
      ? null
      : stage.at === "kind"
        ? { at: "provider" }
        : stage.index > 0
          ? { at: "step", index: stage.index - 1 }
          : provider !== null && offersKindChoice(provider)
            ? { at: "kind" }
            : { at: "provider" };
  // An account is unfinished when its kind has a sign-in step that has not
  // succeeded yet. A kind without one (a key account) works once it is created,
  // so closing the sheet after its profile write failed keeps it.
  const hasUnfinishedAccount =
    created !== undefined && signInStep !== undefined && signedInRunnerId === null;
  const failure =
    (create.error !== null && createIssues.rest ? create.error : null) ??
    install.error ??
    addToProfile.error;
  const error =
    discard.error === null
      ? failure === null
        ? null
        : readErrorMessage(failure)
      : `${created === undefined ? "The account" : buildProviderAccountName(providers, created)} was added but not signed in, and could not be discarded: ${readErrorMessage(discard.error)}`;

  return (
    <>
      <AddProviderAccountSheet
        dialogRef={dialogRef}
        title={provider === null ? "Add an account" : `Add ${provider.displayName}`}
        mark={
          provider === null ? null : (
            <ProviderMark pluginId={provider.pluginId} plugins={plugins} size={16} />
          )
        }
        screen={body}
        error={error}
        onBack={previousStage === null ? null : () => goTo(previousStage)}
        cancelLabel={
          signedInRunnerId !== null ? "Close" : hasUnfinishedAccount ? "Discard" : "Cancel"
        }
        primary={primary}
        onClose={() => {
          if (hasUnfinishedAccount) discard.mutate(created);
          // The account stays, whichever way the sheet closes.
          else if (created !== undefined) closeKeepingAccount(created);
          else onClose();
        }}
      />
      {loginRunnerId === null || createdId === null ? null : (
        <ProviderLoginDialog
          client={client}
          providerAccountId={createdId}
          runnerId={loginRunnerId}
          onSignedIn={() => setSignedInRunnerId(loginRunnerId)}
          onClose={() => setLoginRunnerId(null)}
        />
      )}
    </>
  );
}
