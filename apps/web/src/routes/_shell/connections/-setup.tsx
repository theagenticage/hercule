import { useState, type FormEvent, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Field, Input, LaneLabel } from "@hercule/ui";
import {
  readConfigIssues,
  listCredentialFields,
  queryKeys,
  buildRedirectUri,
  listSetupFlows,
  type ConnectionType,
  type HerculeClient,
  type SetupFlow,
  readErrorMessage,
} from "@hercule/client-core";
import type { Connection } from "@hercule/contract";
import { SaveStatus } from "../../../screens/save-status";
import { DeviceSignIn } from "./-device";
import { Naming } from "./-naming";

/**
 * Returns the label of the button that switches the setup to `flow`, for a
 * type that offers more than one flow.
 */
const labelFlowSwitch = (flow: SetupFlow, type: ConnectionType): string => {
  switch (flow) {
    case "device":
    case "oauth":
      return `Sign in with ${type.displayName} instead`;
    case "credentials":
      return "Paste a token instead";
    case "pairing":
      return "Pair a chat account instead";
  }
};

/**
 * The form that sets up a connection: either a new one, or a fresh credential
 * for an existing one (a reconnect). Both show the same steps because they ask
 * the user for the same thing; only the request they send differs.
 *
 * A type can offer several flows. The form starts with the first one the type
 * declares, and offers the others as quieter buttons under it.
 *
 * - A reconnect with a pasted credential or a device flow asks for no label
 *   or topic. The request leaves them out, and the connection keeps its own;
 *   they are edited under Configure.
 * - A reconnect through a provider redirect also asks for the label and
 *   topic, because it runs the whole setup again and sends them along.
 */
export function ConnectionSetup({
  client,
  type,
  connection,
  onDone,
}: {
  readonly client: HerculeClient;
  readonly type: ConnectionType;
  /** The connection being reconnected; absent when this is a first setup. */
  readonly connection?: Connection;
  readonly onDone: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const flows = listSetupFlows(type);
  const fields = listCredentialFields(type);

  // Undefined when the type offers no flow this build can show.
  const [flow, setFlow] = useState<SetupFlow | undefined>(flows[0]);
  const [pasted, setPasted] = useState<Readonly<Record<string, string>>>({});
  const [label, setLabel] = useState(connection?.label ?? "");
  const [topic, setTopic] = useState(connection?.labels[0] ?? "");

  const submit = useMutation({
    mutationFn: async () => {
      if (flow === "oauth") {
        const { authorizationUrl } = await client.connection.startOAuth({
          payload: {
            type: type.type,
            origin: window.location.origin,
            label,
            labels: [topic],
            ...(connection === undefined ? {} : { connectionId: connection.id }),
          },
        });
        // The rest of the setup happens at the provider, which sends the
        // browser back to the callback route, so the browser leaves this page.
        window.location.assign(authorizationUrl);
        return;
      }
      if (connection !== undefined) {
        await client.connection.setCredentials({
          params: { id: connection.id },
          payload: { credentials: pasted },
        });
        return;
      }
      await client.connection.create({
        payload: { type: type.type, label, labels: [topic], config: {}, credentials: pasted },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.connections() });
      onDone();
    },
  });

  // The device flow finishes in its own panel, which polls until the user
  // approves the code, so starting it only fetches the code. A reconnect sends
  // no label or topic, because the connection keeps its own.
  const startDeviceFlow = useMutation({
    mutationFn: () =>
      client.connection.startDeviceFlow({
        payload: {
          type: type.type,
          ...(connection === undefined
            ? { label, labels: [topic] }
            : { connectionId: connection.id }),
        },
      }),
  });

  // An error about one credential field is shown under that field; any other
  // error is shown at the bottom of the form.
  const issues = readConfigIssues(submit.error, fields, "credentials");
  const failure = startDeviceFlow.error ?? (issues.rest ? submit.error : null);

  // The same column width as the rows and the offers, so the form does not
  // stretch across the whole content width when nothing else does.
  const column = "max-w-[560px]";
  const heading = `${connection === undefined ? "Connect" : "Reconnect"} ${type.displayName}`;

  if (flow === undefined || flow === "pairing") {
    return (
      <div className={`flex flex-col items-start gap-1.5 text-row text-muted ${column}`}>
        <LaneLabel>{heading}</LaneLabel>
        <p>
          {flow === "pairing"
            ? "Pairing a chat account is not built yet."
            : `Setting up ${type.displayName} takes a step this version of Hercule does not know.`}
        </p>
        <Button className="-ml-2" onClick={onDone}>
          Back
        </Button>
      </div>
    );
  }

  // The panel replaces the form from the moment a code is asked for, and stays
  // while a new code is asked for after the last one ran out.
  if (flow === "device" && (startDeviceFlow.isPending || startDeviceFlow.data !== undefined)) {
    return (
      <div className={`flex flex-col gap-3 ${column}`}>
        <div className="-mb-2.5">
          <LaneLabel>{heading}</LaneLabel>
        </div>
        {startDeviceFlow.data === undefined ? (
          <p className="text-row text-muted" role="status">
            Asking {type.displayName} for a code.
          </p>
        ) : (
          <DeviceSignIn
            // A new code is a new flow, so its panel starts with no polls.
            key={startDeviceFlow.data.setupId}
            client={client}
            providerName={type.displayName}
            start={startDeviceFlow.data}
            restarting={startDeviceFlow.isPending}
            onRestart={() => {
              startDeviceFlow.mutate();
            }}
            onCancel={onDone}
            onDone={onDone}
          />
        )}
      </div>
    );
  }

  const idPrefix = connection?.id ?? type.type;
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (flow === "device") startDeviceFlow.mutate();
    else submit.mutate();
  };

  /** Switches the form to another flow, dropping the last attempt's error. */
  const switchFlow = (next: SetupFlow): void => {
    submit.reset();
    startDeviceFlow.reset();
    setFlow(next);
  };

  return (
    <form className={`flex flex-col gap-3 ${column}`} onSubmit={send}>
      {/* The form replaces the offers, so this heading names what is being set
          up, styled like the lane labels around it. */}
      <div className="-mb-2.5">
        <LaneLabel>{heading}</LaneLabel>
      </div>
      {type.setup.map((step, index) =>
        step.kind === "checklist" ? (
          // A checklist step holds the provider's own instructions, shown as written.
          <p key={index} className="max-w-[52ch] text-row whitespace-pre-line text-muted">
            {step.markdown}
          </p>
        ) : null,
      )}

      {flow === "oauth" ? (
        <p className="max-w-[52ch] text-row text-muted">
          Register this redirect URI with the provider:{" "}
          <code className="font-mono text-fine break-all text-ink">
            {buildRedirectUri(window.location.origin)}
          </code>
        </p>
      ) : null}

      {flow === "credentials"
        ? fields.map((field) => (
            <Field
              key={field.name}
              id={`${idPrefix}-${field.name}`}
              label={field.label}
              error={issues.perField[field.name]}
            >
              {field.help === undefined ? null : (
                <p className="text-fine text-faint">{field.help}</p>
              )}
              <Input
                id={`${idPrefix}-${field.name}`}
                // A pasted credential is never read back, so it is never prefilled.
                type="password"
                autoComplete="off"
                required
                value={pasted[field.name] ?? ""}
                onChange={(event) => {
                  // Clears the last attempt's error, because that error was about
                  // the old value, not the one being typed now.
                  if (!submit.isIdle) submit.reset();
                  const value = event.target.value;
                  setPasted((current) => ({ ...current, [field.name]: value }));
                }}
              />
            </Field>
          ))
        : null}

      {connection === undefined || flow === "oauth" ? (
        <Naming
          idPrefix={idPrefix}
          label={label}
          topic={topic}
          onLabel={setLabel}
          onTopic={setTopic}
        />
      ) : null}

      <div className="flex items-center gap-1.5">
        <Button type="button" variant="form" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="form"
          disabled={submit.isPending || startDeviceFlow.isPending}
        >
          {flow === "device" ? `Sign in with ${type.displayName}` : "Connect"}
        </Button>
      </div>

      {flows
        .filter((other) => other !== flow)
        .map((other) => (
          <Button
            key={other}
            type="button"
            className="-mt-1.5 -ml-2 self-start"
            onClick={() => {
              switchFlow(other);
            }}
          >
            {labelFlowSwitch(other, type)}
          </Button>
        ))}

      {/* A successful setup closes the form and its row appears, so only a
          failure is shown here. */}
      <SaveStatus saved={false} failure={failure === null ? null : readErrorMessage(failure)} />
    </form>
  );
}
