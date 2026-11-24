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
 * An OAuth sign-in that is finishing in the browser: the provider's page at
 * `authorizationUrl` is open, and `before` holds the Connections read when
 * the sign-in started.
 */
interface BrowserSignIn {
  readonly authorizationUrl: string;
  readonly before: readonly Connection[];
}

/**
 * An OAuth sign-in whose return is caught on this machine: `signIn` holds the
 * provider's page and the listener, and `attempt` is the sign-in's lifetime,
 * which aborts when the dialog closes or the user starts again. Everything
 * that answers late (a return, the controller, the browser) first checks that
 * its attempt has not aborted, so it never touches a later sign-in or a closed
 * dialog.
 *
 * - `endedMessage`: why the sign-in ended without a Connection, or null.
 * - `finishing`: the controller is finishing the sign-in.
 * - `pasted`, `pasteProblem`: the address the user pastes when nothing
 *   listens, and why the last one was refused.
 */
interface LocalReturnProgress {
  readonly signIn: LocalReturnSignIn;
  readonly attempt: AbortController;
  readonly endedMessage: string | null;
  readonly finishing: boolean;
  readonly pasted: string;
  readonly pasteProblem: string | null;
}

/** Where the start of an OAuth sign-in stands: `busy` while the controller answers, and `error` for its refusal. */
interface OAuthStart {
  readonly busy: boolean;
  readonly error: string | null;
}

const NOT_STARTING: OAuthStart = { busy: false, error: null };

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
  const [browserSignIn, setBrowserSignIn] = useState<BrowserSignIn | null>(null);
  const [localReturn, setLocalReturn] = useState<LocalReturnProgress | null>(null);
  const [oauthStart, setOauthStart] = useState<OAuthStart>(NOT_STARTING);
  // The attempt of the sign-in that is starting or running, if any.
  const attemptRef = useRef<AbortController | null>(null);
  // A reconnect signs in with the client the Connection has. It asks for the
  // values to make the client again only when the user chooses to.
  const [clientSetupAsked, setClientSetupAsked] = useState(connection === undefined);
  // Why the sign-in page did not open, shown until the user moves on.
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
  const openLink = (url: string): void => {
    // Main opens only web addresses, so anything else would fail there
    // without a word.
    if (!isWebLink(url)) {
      setLinkError(`The sign-in page is not a web address, so it was not opened: ${url}`);
      return;
    }
    setLinkError(null);
    // The port reports a refusal of main too, which `link.open` answers without failing.
    port.open(url).catch((error: unknown) => {
      setLinkError(describeOpenFailure(error));
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
    setLocalReturn(null);
    setOauthStart(NOT_STARTING);
  };
  /** Shows why `attempt` ended without a Connection, unless it was abandoned. */
  const endLocalReturn = (attempt: AbortController, message: string): void => {
    if (attempt.signal.aborted) return;
    setLocalReturn((current) =>
      current?.attempt === attempt
        ? { ...current, endedMessage: message, finishing: false }
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
    callbackQuery: string,
  ): Promise<void> => {
    if (attempt.signal.aborted) return;
    setLocalReturn((current) =>
      current?.attempt === attempt ? { ...current, finishing: true, pasted: "" } : current,
    );
    try {
      await client.connection.finishOAuth({ payload: { callbackQuery } });
    } catch (error) {
      endLocalReturn(attempt, readErrorMessage(error));
      return;
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.connections() });
    if (!attempt.signal.aborted) close();
  };
  /** Opens the provider's page of `attempt` through the port, and shows why it did not open. */
  const openLocalReturnPage = async (
    signIn: LocalReturnSignIn,
    attempt: AbortController,
  ): Promise<void> => {
    setLinkError(null);
    try {
      await signIn.openPage();
    } catch (error) {
      if (!attempt.signal.aborted) setLinkError(describeOpenFailure(error));
    }
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
    setOauthStart(NOT_STARTING);
    setLocalReturn({
      signIn,
      attempt,
      endedMessage: null,
      finishing: false,
      pasted: "",
      pasteProblem: null,
    });
    if (signIn.returnBy === "listener") {
      void signIn.awaitReturn().then((outcome) => {
        if (attempt.signal.aborted) return;
        if (outcome.kind === "received") void finishLocalReturn(attempt, outcome.callbackQuery);
        else endLocalReturn(attempt, outcome.message);
      });
    }
    await openLocalReturnPage(signIn, attempt);
  };
  const finishPasted = (): void => {
    if (localReturn === null) return;
    const reading = readPastedReturn(localReturn.signIn.authorizationUrl, localReturn.pasted);
    if (reading.kind === "refused") {
      setLocalReturn({ ...localReturn, pasteProblem: reading.message });
      return;
    }
    void finishLocalReturn(localReturn.attempt, reading.callbackQuery);
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
    setOauthStart({ busy: true, error: null });
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
      setOauthStart(NOT_STARTING);
      setBrowserSignIn({ authorizationUrl, before });
      openLink(authorizationUrl);
    } catch (error) {
      if (!attempt.signal.aborted) setOauthStart({ busy: false, error: readErrorMessage(error) });
    }
  };

  // An OAuth sign-in ends in the browser. The controller announces the
  // Connection it writes on the `connection` topic, and the shell reads the
  // list again, so the dialog learns of it here.
  const oauthConnection =
    browserSignIn === null
      ? undefined
      : findOAuthConnection(browserSignIn.before, connections, {
          type: type.type,
          ...reconnectPayload,
        });
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
    busy: oauthStart.busy,
    fieldErrors: {},
    error: oauthStart.error,
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
        browserSignIn,
        localReturn,
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
          if (oauthStart.error !== null) setOauthStart(NOT_STARTING);
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
          if (localReturn === null) openLink(url);
          else void openLocalReturnPage(localReturn.signIn, localReturn.attempt);
        },
        onAskClientSetup: () => {
          setClientSetupAsked(true);
        },
        onPasteChange: (text) => {
          setLocalReturn((current) =>
            current === null ? null : { ...current, pasted: text, pasteProblem: null },
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
 * form and sign-in. `linkError` says why the sign-in page did not open, or
 * is null.
 */
const decideSetupState = (
  flow: SetupFlow | undefined,
  read: {
    readonly credentialsForm: FormState;
    readonly oauthForm: FormState;
    readonly deviceSignIn: DeviceSignInProgress;
    readonly browserSignIn: BrowserSignIn | null;
    readonly localReturn: LocalReturnProgress | null;
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
      if (read.localReturn !== null) {
        const { signIn, endedMessage, finishing, pasted, pasteProblem } = read.localReturn;
        return endedMessage !== null
          ? describeSignInFailure(endedMessage)
          : {
              kind: "returning",
              authorizationUrl: signIn.authorizationUrl,
              linkError: read.linkError,
              finishing,
              paste: signIn.returnBy === "paste" ? { text: pasted, problem: pasteProblem } : null,
            };
      }
      return read.browserSignIn === null
        ? { kind: "form", flow, ...read.oauthForm }
        : {
            kind: "browser",
            authorizationUrl: read.browserSignIn.authorizationUrl,
            linkError: read.linkError,
          };
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
