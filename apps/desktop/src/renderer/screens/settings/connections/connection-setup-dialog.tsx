import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildRedirectUriToRegister,
  decideOAuthReturnPath,
  describeConnectionTypeName,
  describeSignInFailure,
  findOAuthConnection,
  isWebLink,
  listCredentialFields,
  listFlowSwitches,
  listSetupFlows,
  queryKeys,
  readClientValues,
  readConfigIssues,
  readErrorMessage,
  readPastedReturn,
  startLocalReturnSignIn,
  type ConnectionType,
  type LocalReturnSignIn,
  type SetupFlow,
} from "@hercule/client-core";
import type { Connection } from "@hercule/contract";
import { buildBrowserSignInPort } from "../../../app/browser-sign-in-port";
import { useDeviceSignIn, type DeviceSignInProgress } from "../../../app/device-sign-in";
import { connectionsQuery, pluginsQuery } from "../../../app/queries";
import {
  ConnectionSetup,
  type ClientSetupForm,
  type ConnectionSetupState,
} from "./connection-setup";

/**
 * Where an OAuth sign-in stands. Each phase holds only what it needs, so a
 * finished phase leaves nothing behind. The sign-in's abort controller is not
 * part of it: it is the synchronous handle that ends the sign-in (see
 * `attemptRef`), and a result that arrives late checks it before touching the
 * phase.
 *
 * - `idle`: the form. `error` is why the last start was refused, or null.
 * - `starting`: the controller has not answered the start.
 * - `legacy-wait`: the browser is at the provider and returns to the
 *   controller. `before` holds the Connections read when the sign-in started,
 *   so the one it writes is told from those there already.
 * - `return-wait`: the browser returns to this machine. `signIn` holds the
 *   provider's page and the listener. `pasted` and `pasteProblem` are the
 *   address the user pastes when nothing listens, and why the last was refused.
 * - `finishing`: the controller is finishing the sign-in the browser returned
 *   to this machine. The provider's page can still be opened again, and a
 *   refusal to open it still shows.
 * - `refused`: the sign-in ended without a Connection, for `message`.
 *
 * `linkError` says why the provider's page did not open, or is null.
 */
type OAuthPhase =
  | { readonly kind: "idle"; readonly error: string | null }
  | { readonly kind: "starting" }
  | {
      readonly kind: "legacy-wait";
      readonly authorizationUrl: string;
      readonly before: readonly Connection[];
      readonly linkError: string | null;
    }
  | {
      readonly kind: "return-wait";
      readonly signIn: LocalReturnSignIn;
      readonly linkError: string | null;
      readonly pasted: string;
      readonly pasteProblem: string | null;
    }
  | {
      readonly kind: "finishing";
      readonly signIn: LocalReturnSignIn;
      readonly linkError: string | null;
    }
  | { readonly kind: "refused"; readonly message: string };

const IDLE: OAuthPhase = { kind: "idle", error: null };

/** Returns the line that says why the browser did not open the sign-in page. */
const describeOpenFailure = (error: unknown): string =>
  `The browser did not open the sign-in page: ${readErrorMessage(error)}`;

/**
 * Renders the setup of a Connection of `type` in a glass dialog, or, with
 * `connection`, a fresh credential for that Connection (Reconnect). The
 * dialog starts with the first flow the type declares and offers the others
 * as links (spec 17 §Settings, Connections):
 *
 * - credentials: the pasted secrets go to `connection.create`, or to
 *   `connection.setCredentials` on a reconnect;
 * - device: the user enters a code at the provider, as in the first run's
 *   GitHub step. The dialog polls for the flow's end only while the code is
 *   on screen, and stops on Cancel, on a switch of flow, and when it closes;
 * - OAuth: the provider's page opens in the default browser, and the dialog
 *   closes once the Connection the sign-in writes arrives on the
 *   `connection` live topic, which the shell holds;
 * - OAuth with a return to this machine (see `decideOAuthReturnPath`, Slack):
 *   the app listens for the browser's return and finishes the sign-in with
 *   `connection.finishOAuth`, whose answer closes the dialog. A type that
 *   creates its OAuth client at setup also asks for the values to create it
 *   from. A reconnect asks for none, and offers to set the client up again.
 *
 * The dialog closes once the Connection is set up. `onClose` is called
 * whenever it closes, set up or not; the caller then unmounts it.
 */
export function ConnectionSetupDialog({
  type,
  connection,
  onClose,
}: {
  readonly type: ConnectionType;
  /** The Connection being reconnected; absent when this sets up a new one. */
  readonly connection?: Connection;
  /** Called when the dialog closes, set up or not. The caller then unmounts it. */
  readonly onClose: () => void;
}): JSX.Element {
  const { bridge } = useRouteContext({ from: "__root__" });
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const queryClient = useQueryClient();
  const connections = useSuspenseQuery(connectionsQuery(client)).data;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fields = listCredentialFields(type);
  // The OAuth redirect goes to the controller, as from the web app, so the
  // redirect URI the provider has registered matches either way.
  const origin = new URL(controller.url).origin;
  // The part of a start's payload that names the Connection being reconnected.
  const reconnectPayload = connection === undefined ? {} : { connectionId: connection.id };

  // Undefined when the type offers no flow this version can show.
  const [flow, setFlow] = useState<SetupFlow | undefined>(listSetupFlows(type)[0]);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [phase, setPhase] = useState<OAuthPhase>(IDLE);
  // The attempt of the sign-in that is starting or running, if any.
  const attemptRef = useRef<AbortController | null>(null);
  // A reconnect signs in with the client the Connection has. It asks for the
  // values to make the client again only when the user chooses to.
  const [clientSetupAsked, setClientSetupAsked] = useState(connection === undefined);
  // Why the page of a device flow did not open, shown until the user moves on.
  const [linkError, setLinkError] = useState<string | null>(null);

  /**
   * Closes the dialog. The attempt of a sign-in ends first, in the same step:
   * the native close event, and the unmount it leads to, come later, and a
   * result delivered in between must not open, finish or show anything.
   */
  const close = (): void => {
    attemptRef.current?.abort();
    dialogRef.current?.close();
  };
  const port = useMemo(() => buildBrowserSignInPort(bridge), [bridge]);
  /**
   * Opens `url` in the browser through the port, and reports to `report` why it
   * did not open, or null when it is opening. Main opens only web addresses,
   * so anything else would fail there without a word.
   */
  const openPage = (url: string, report: (message: string | null) => void): void => {
    if (!isWebLink(url)) {
      report(`The sign-in page is not a web address, so it was not opened: ${url}`);
      return;
    }
    report(null);
    // The port reports a refusal of main too, which `link.open` answers without failing.
    port.open(url).catch((error: unknown) => {
      report(describeOpenFailure(error));
    });
  };

  const saveCredentials = useMutation({
    mutationFn: () =>
      connection === undefined
        ? client.connection.create({ payload: { type: type.type, credentials: values } })
        : client.connection.setCredentials({
            params: { id: connection.id },
            payload: { credentials: values },
          }),
    // The Connection exists from this answer on, even when the dialog is
    // gone, so the list is read again either way.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.connections() }),
  });
  const deviceSignIn = useDeviceSignIn({
    client,
    type: type.type,
    ...reconnectPayload,
    providerName: type.displayName,
    onDone: close,
  });
  const clientValues = readClientValues(type, values);
  const returnPath = decideOAuthReturnPath(type, "desktop");
  // The sign-in ends with the dialog, also while the controller has not answered the start.
  useEffect(
    () => () => {
      attemptRef.current?.abort();
    },
    [],
  );

  /** Ends the sign-in that starts or runs: its listener closes, and what it still awaits is dropped. */
  const abandonSignIn = (): void => {
    attemptRef.current?.abort();
    attemptRef.current = null;
    setPhase(IDLE);
  };
  /** Shows why `attempt` ended without a Connection, unless it was abandoned. */
  const refuseSignIn = (attempt: AbortController, message: string): void => {
    if (!attempt.signal.aborted) setPhase({ kind: "refused", message });
  };
  /** Shows why the provider's page of `attempt` did not open, unless it was abandoned or has ended. */
  const showLinkError = (attempt: AbortController, message: string | null): void => {
    if (attempt.signal.aborted) return;
    setPhase((current) =>
      current.kind === "legacy-wait" ||
      current.kind === "return-wait" ||
      current.kind === "finishing"
        ? { ...current, linkError: message }
        : current,
    );
  };
  /**
   * Hands what the browser came back with to `connection.finishOAuth`. The
   * request is not a mutation, so the one-time code stays out of the mutation
   * cache. Its answer closes the dialog, unless the attempt was abandoned: the
   * Connection exists then all the same, so the list is read again.
   */
  const finishLocalReturn = async (
    attempt: AbortController,
    signIn: LocalReturnSignIn,
    callbackQuery: string,
  ): Promise<void> => {
    if (attempt.signal.aborted) return;
    setPhase((current) => ({
      kind: "finishing",
      signIn,
      linkError: current.kind === "return-wait" ? current.linkError : null,
    }));
    try {
      await client.connection.finishOAuth({ payload: { callbackQuery } });
    } catch (error) {
      refuseSignIn(attempt, readErrorMessage(error));
      return;
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.connections() });
    if (!attempt.signal.aborted) close();
  };
  /**
   * Starts an OAuth sign-in that returns to this machine. The wait for the
   * browser is armed before the browser opens, because the listener refuses a
   * return until it knows which sign-in to expect.
   */
  const startLocalReturnFlow = async (
    attempt: AbortController,
    start: Parameters<typeof startLocalReturnSignIn>[1],
  ): Promise<void> => {
    const signIn = await startLocalReturnSignIn({ client, port }, start, attempt.signal);
    setPhase({ kind: "return-wait", signIn, linkError: null, pasted: "", pasteProblem: null });
    if (signIn.returnBy === "listener") {
      void signIn.awaitReturn().then((outcome) => {
        if (attempt.signal.aborted) return;
        if (outcome.kind === "received") {
          void finishLocalReturn(attempt, signIn, outcome.callbackQuery);
        } else {
          refuseSignIn(attempt, outcome.message);
        }
      });
    }
    await openReturnPage(attempt, signIn);
  };
  /** Opens the provider's page of the sign-in that returns to this machine, and shows why it did not open. */
  const openReturnPage = async (
    attempt: AbortController,
    signIn: LocalReturnSignIn,
  ): Promise<void> => {
    showLinkError(attempt, null);
    try {
      await signIn.openPage();
    } catch (error) {
      showLinkError(attempt, describeOpenFailure(error));
    }
  };
  const finishPasted = (): void => {
    const attempt = attemptRef.current;
    if (attempt === null || phase.kind !== "return-wait") return;
    const reading = readPastedReturn(phase.signIn.authorizationUrl, phase.pasted);
    if (reading.kind === "refused") {
      setPhase({ ...phase, pasteProblem: reading.message });
      return;
    }
    void finishLocalReturn(attempt, phase.signIn, reading.callbackQuery);
  };
  /**
   * Starts an OAuth sign-in and opens the provider's page. The pasted values
   * are one-shot: they leave the form as the request starts, and the request
   * is no mutation, so they are not kept in the mutation cache either.
   */
  const startBrowserSignIn = async (): Promise<void> => {
    abandonSignIn();
    const attempt = new AbortController();
    attemptRef.current = attempt;
    const sent = clientSetupAsked ? clientValues : undefined;
    setValues({});
    setPhase({ kind: "starting" });
    // Read before the sign-in starts, so a Connection it writes is never
    // taken for one that was there already.
    const before = connections;
    const start = {
      type: type.type,
      ...reconnectPayload,
      ...(sent === undefined ? {} : { clientValues: sent }),
    };
    try {
      if (returnPath === "local-listener") {
        await startLocalReturnFlow(attempt, start);
        return;
      }
      const { authorizationUrl } = await client.connection.startOAuth({
        payload: { ...start, origin },
      });
      if (attempt.signal.aborted) return;
      setPhase({ kind: "legacy-wait", authorizationUrl, before, linkError: null });
      openPage(authorizationUrl, (message) => {
        showLinkError(attempt, message);
      });
    } catch (error) {
      if (!attempt.signal.aborted) setPhase({ kind: "idle", error: readErrorMessage(error) });
    }
  };

  // An OAuth sign-in ends in the browser. The controller announces the
  // Connection it writes on the `connection` topic, and the shell reads the
  // list again, so the dialog learns of it here.
  const oauthConnection =
    phase.kind === "legacy-wait"
      ? findOAuthConnection(phase.before, connections, { type: type.type, ...reconnectPayload })
      : undefined;
  useEffect(() => {
    if (oauthConnection !== undefined) close();
  }, [oauthConnection]);

  const issues = readConfigIssues(saveCredentials.error, fields, "credentials");
  const credentialsForm = {
    busy: saveCredentials.isPending,
    fieldErrors: issues.perField,
    error: issues.rest ? readErrorMessage(saveCredentials.error) : null,
  };
  const clientSetup: ClientSetupForm | undefined =
    type.clientSetupFields.length === 0
      ? undefined
      : {
          fields: type.clientSetupFields,
          asked: clientSetupAsked,
          complete: clientValues !== undefined,
          reconnect: connection !== undefined,
        };
  const oauthForm = {
    busy: phase.kind === "starting",
    fieldErrors: {},
    error: phase.kind === "idle" ? phase.error : null,
    ...(clientSetup === undefined ? {} : { clientSetup }),
  };

  return (
    <ConnectionSetup
      dialogRef={dialogRef}
      heading={
        connection === undefined
          ? `Connect ${type.displayName}`
          : `Reconnect ${describeConnectionTypeName(connection, type)} · ${connection.label}`
      }
      type={type}
      plugins={plugins}
      state={decideSetupState(flow, {
        credentialsForm,
        oauthForm,
        deviceSignIn: deviceSignIn.progress,
        oauthPhase: phase,
        linkError,
      })}
      values={values}
      redirectUri={buildRedirectUriToRegister(type, origin)}
      flowSwitches={flow === undefined ? [] : listFlowSwitches(type, flow)}
      actions={{
        onFieldChange: (name, value) => {
          // The last attempt's error was about the old value, not this one.
          // The fields cannot change while a save is pending: resetting then
          // would drop the save's answer, and the dialog would stay open.
          if (saveCredentials.isError) saveCredentials.reset();
          // The refusal of a start was about the value that has left the form.
          if (phase.kind === "idle" && phase.error !== null) setPhase(IDLE);
          setValues((current) => ({ ...current, [name]: value }));
        },
        onSubmit: () => {
          setLinkError(null);
          // React Query calls a callback passed to `mutate` only while the
          // dialog is on screen, so a late answer cannot close another dialog.
          if (flow === "credentials") saveCredentials.mutate(undefined, { onSuccess: close });
          else if (flow === "device") deviceSignIn.start();
          else void startBrowserSignIn();
        },
        onSwitchFlow: (next) => {
          // The switches are disabled while a save is pending, so only a
          // settled error is reset here.
          if (saveCredentials.isError) saveCredentials.reset();
          abandonSignIn();
          deviceSignIn.cancel();
          setValues({});
          setLinkError(null);
          setFlow(next);
        },
        onCancelCode: () => {
          setLinkError(null);
          deviceSignIn.cancel();
        },
        onStartAgain: () => {
          setLinkError(null);
          if (flow === "oauth") abandonSignIn();
          else deviceSignIn.start();
        },
        onOpen: (url) => {
          const attempt = attemptRef.current;
          if ((phase.kind === "return-wait" || phase.kind === "finishing") && attempt !== null) {
            void openReturnPage(attempt, phase.signIn);
          } else if (phase.kind === "legacy-wait" && attempt !== null) {
            openPage(url, (message) => {
              showLinkError(attempt, message);
            });
          } else {
            openPage(url, setLinkError);
          }
        },
        onAskClientSetup: () => {
          setClientSetupAsked(true);
        },
        onPasteChange: (text) => {
          setPhase((current) =>
            current.kind === "return-wait"
              ? { ...current, pasted: text, pasteProblem: null }
              : current,
          );
        },
        onFinishPasted: finishPasted,
      }}
      onCloseRequest={close}
      onClose={onClose}
    />
  );
}

/** The credential form's or the OAuth form's own state, as the setup shows it. */
type FormState = Omit<Extract<ConnectionSetupState, { kind: "form" }>, "kind" | "flow">;

/**
 * Decides what the setup shows for `flow`, from the state of each flow's
 * form and sign-in. `linkError` says why the page of a device flow did not
 * open, or is null.
 */
const decideSetupState = (
  flow: SetupFlow | undefined,
  read: {
    readonly credentialsForm: FormState;
    readonly oauthForm: FormState;
    readonly deviceSignIn: DeviceSignInProgress;
    readonly oauthPhase: OAuthPhase;
    readonly linkError: string | null;
  },
): ConnectionSetupState => {
  switch (flow) {
    case undefined:
      return { kind: "unsupported" };
    case "pairing":
      return { kind: "unsupported", flow };
    case "credentials":
      return { kind: "form", flow, ...read.credentialsForm };
    case "oauth":
      return decideOAuthState(read.oauthPhase, { kind: "form", flow, ...read.oauthForm });
    case "device":
      switch (read.deviceSignIn.kind) {
        case "idle":
        case "starting":
          return {
            kind: "form",
            flow,
            busy: read.deviceSignIn.kind === "starting",
            fieldErrors: {},
            error: null,
          };
        case "code":
          return { ...read.deviceSignIn, linkError: read.linkError };
        case "ended":
          return read.deviceSignIn;
      }
  }
};

/**
 * Decides what the setup shows for the phase of an OAuth sign-in: `form`, the
 * form, for a sign-in that has not left it, or the card that waits for the
 * browser, or the way the sign-in ended.
 */
const decideOAuthState = (
  phase: OAuthPhase,
  form: Extract<ConnectionSetupState, { kind: "form" }>,
): ConnectionSetupState => {
  switch (phase.kind) {
    case "idle":
    case "starting":
      return form;
    case "legacy-wait":
      return {
        kind: "browser",
        authorizationUrl: phase.authorizationUrl,
        linkError: phase.linkError,
      };
    case "return-wait":
      return {
        kind: "returning",
        authorizationUrl: phase.signIn.authorizationUrl,
        linkError: phase.linkError,
        finishing: false,
        paste:
          phase.signIn.returnBy === "paste"
            ? { text: phase.pasted, problem: phase.pasteProblem }
            : null,
      };
    case "finishing":
      return {
        kind: "returning",
        authorizationUrl: phase.signIn.authorizationUrl,
        linkError: phase.linkError,
        finishing: true,
        paste: phase.signIn.returnBy === "paste" ? { text: "", problem: null } : null,
      };
    case "refused":
      return describeSignInFailure(phase.message);
  }
};
