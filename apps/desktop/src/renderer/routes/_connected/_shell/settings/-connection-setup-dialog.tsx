import { useEffect, useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildRedirectUriToRegister,
  describeConnectionTypeName,
  findOAuthConnection,
  isWebLink,
  listCredentialFields,
  listFlowSwitches,
  listSetupFlows,
  queryKeys,
  readConfigIssues,
  readErrorMessage,
  type ConnectionType,
  type SetupFlow,
} from "@hercule/client-core";
import type { Connection } from "@hercule/contract";
import { useDeviceSignIn, type DeviceSignInProgress } from "../../../../app/device-sign-in";
import { connectionsQuery, pluginsQuery } from "../../../../app/queries";
import {
  ConnectionSetup,
  type ConnectionSetupState,
} from "../../../../screens/settings/connections";

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
 *   `connection` live topic, which the shell holds.
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
  // Why the sign-in page did not open, shown until the user moves on.
  const [linkError, setLinkError] = useState<string | null>(null);

  const close = (): void => dialogRef.current?.close();
  const openLink = (url: string): void => {
    // Main opens only web addresses, so anything else would fail there
    // without a word.
    if (!isWebLink(url)) {
      setLinkError(`The sign-in page is not a web address, so it was not opened: ${url}`);
      return;
    }
    setLinkError(null);
    bridge.link.open({ url }).catch((error: unknown) => {
      setLinkError(`The browser did not open the sign-in page: ${readErrorMessage(error)}`);
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
  const startOAuth = useMutation({
    mutationFn: () =>
      client.connection.startOAuth({ payload: { type: type.type, origin, ...reconnectPayload } }),
  });
  /**
   * Starts an OAuth sign-in and opens the provider's page. A switch of flow
   * resets the mutation, which drops an answer that arrives after it.
   */
  const startBrowserSignIn = (): void => {
    // Read before the sign-in starts, so a Connection it writes is never
    // taken for one that was there already.
    const before = connections;
    startOAuth.mutate(undefined, {
      onSuccess: ({ authorizationUrl }) => {
        setBrowserSignIn({ authorizationUrl, before });
        openLink(authorizationUrl);
      },
    });
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
    if (oauthConnection !== undefined) dialogRef.current?.close();
  }, [oauthConnection]);

  const issues = readConfigIssues(saveCredentials.error, fields, "credentials");
  const credentialsForm = {
    busy: saveCredentials.isPending,
    fieldErrors: issues.perField,
    error: issues.rest ? readErrorMessage(saveCredentials.error) : null,
  };
  const oauthForm = {
    busy: startOAuth.isPending,
    fieldErrors: {},
    error: startOAuth.error === null ? null : readErrorMessage(startOAuth.error),
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
          setValues((current) => ({ ...current, [name]: value }));
        },
        onSubmit: () => {
          setLinkError(null);
          // React Query calls a callback passed to `mutate` only while the
          // dialog is on screen, so a late answer cannot close another dialog.
          if (flow === "credentials") saveCredentials.mutate(undefined, { onSuccess: close });
          else if (flow === "device") deviceSignIn.start();
          else startBrowserSignIn();
        },
        onSwitchFlow: (next) => {
          // The switches are disabled while a save is pending, so only a
          // settled error is reset here.
          if (saveCredentials.isError) saveCredentials.reset();
          startOAuth.reset();
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
          deviceSignIn.start();
        },
        onOpen: openLink,
      }}
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
