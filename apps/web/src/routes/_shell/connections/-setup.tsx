import { useState, type FormEvent, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Field, Input, LaneLabel } from "@hydra/ui";
import {
  configIssues,
  queryKeys,
  redirectUriFor,
  type ConnectionType,
  type CredentialField,
  type HydraClient,
  type SetupStep,
} from "@hydra/client-core";
import type { Connection } from "@hydra/contract";
import { SaveStatus, messageOf } from "../../../screens/save-status";
import { Naming } from "./-naming";

const credentialFields = (setup: ReadonlyArray<SetupStep>): ReadonlyArray<CredentialField> =>
  setup.flatMap((step) => (step.kind === "credentials" ? [...step.fields] : []));

/**
 * Setting up one connection, whether it is the first or a fresh credential for
 * one that already exists. Both render the same steps because they ask the same
 * thing of the user; what differs is where the answer goes.
 *
 * A reconnect that pastes a credential asks for nothing but the credential: the
 * write carries only that, and the label and the topic are edited under
 * Configure. A reconnect through a redirect asks for both, because it starts
 * the whole setup again and carries them along.
 */
export function ConnectionSetup({
  client,
  type,
  connection,
  onDone,
}: {
  readonly client: HydraClient;
  readonly type: ConnectionType;
  /** The connection being reconnected; absent when this is a first setup. */
  readonly connection?: Connection;
  readonly onDone: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const fields = credentialFields(type.setup);
  const redirects = type.setup.some((step) => step.kind === "oauth");

  const [pasted, setPasted] = useState<Readonly<Record<string, string>>>({});
  const [label, setLabel] = useState(connection?.label ?? "");
  const [topic, setTopic] = useState(connection?.labels[0] ?? "");

  const submit = useMutation({
    mutationFn: async () => {
      if (redirects) {
        const { authorizationUrl } = await client.connection.startOAuth({
          payload: {
            type: type.type,
            origin: window.location.origin,
            label,
            labels: [topic],
            ...(connection === undefined ? {} : { connectionId: connection.id }),
          },
        });
        // The rest of this setup happens at the provider and comes back on the
        // callback route, so the browser leaves rather than waiting here.
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

  // The type answers which credential it refused, so that message belongs under
  // the field it named; anything else refused is the form's own to say.
  const issues = configIssues(submit.error, fields, "credentials");
  const failure = issues.rest ? submit.error : null;

  // The same column the rows and the offers sit in: a form that spans the
  // whole content width would be the one thing on the screen that does.
  const column = "max-w-[560px]";
  const heading = `${connection === undefined ? "Connect" : "Reconnect"} ${type.displayName}`;

  if (!redirects && fields.length === 0) {
    return (
      <div className={`flex flex-col items-start gap-1.5 text-row text-muted ${column}`}>
        <LaneLabel>{heading}</LaneLabel>
        <p>
          {type.setup.some((step) => step.kind === "pairing")
            ? "Pairing a chat account is not built yet."
            : `Setting up ${type.displayName} takes a step this version of Hydra does not know.`}
        </p>
        <Button className="-ml-2" onClick={onDone}>
          Back
        </Button>
      </div>
    );
  }

  const idPrefix = connection?.id ?? type.type;
  const send = (event: FormEvent): void => {
    event.preventDefault();
    submit.mutate();
  };

  return (
    <form className={`flex flex-col gap-3 ${column}`} onSubmit={send}>
      {/* The offers it replaced are gone, so the form says what is being set
          up, in the same voice as the lane labels around it. */}
      <div className="-mb-2.5">
        <LaneLabel>{heading}</LaneLabel>
      </div>
      {type.setup.map((step, index) =>
        step.kind === "checklist" ? (
          // A checklist is the provider's own instructions, in their words.
          <p key={index} className="max-w-[52ch] text-row whitespace-pre-line text-muted">
            {step.markdown}
          </p>
        ) : null,
      )}

      {redirects ? (
        <p className="max-w-[52ch] text-row text-muted">
          Register this redirect URI with the provider:{" "}
          <code className="font-mono text-fine break-all text-ink">
            {redirectUriFor(window.location.origin)}
          </code>
        </p>
      ) : null}

      {fields.map((field) => (
        <Field
          key={field.name}
          id={`${idPrefix}-${field.name}`}
          label={field.label}
          error={issues.perField[field.name]}
        >
          {field.help === undefined ? null : <p className="text-fine text-faint">{field.help}</p>}
          <Input
            id={`${idPrefix}-${field.name}`}
            // A pasted credential is never read back, so it is never prefilled.
            type="password"
            autoComplete="off"
            required
            value={pasted[field.name] ?? ""}
            onChange={(event) => {
              // What the last try was refused for is about what was in the
              // box, not about what is being typed now.
              if (!submit.isIdle) submit.reset();
              const value = event.target.value;
              setPasted((current) => ({ ...current, [field.name]: value }));
            }}
          />
        </Field>
      ))}

      {connection === undefined || redirects ? (
        <Naming
          idPrefix={idPrefix}
          label={label}
          topic={topic}
          onLabel={setLabel}
          onTopic={setTopic}
        />
      ) : null}

      <div className="flex items-center gap-1.5">
        <Button type="submit" variant="form" disabled={submit.isPending}>
          Connect
        </Button>
        <Button type="button" variant="form" onClick={onDone}>
          Cancel
        </Button>
      </div>

      {/* Nothing to say about a setup that worked: it closes and its row
          appears, so only a refusal outlives the press. */}
      <SaveStatus saved={false} failure={failure === null ? null : messageOf(failure)} />
    </form>
  );
}
