import { useState, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import {
  ADDRESS_FIELD_HINT,
  describeExistsRefusal,
  describePluginOriginRefusal,
  readAddForm,
  type FlowProblem,
  type RefusalDescription,
} from "@hercule/client-core/mcp-servers";
import { Button, Field, Input } from "@hercule/ui";
import { useUrlServerFlow } from "../../app/mcp-url-server-flow";
import { connectionsQuery, pluginsQuery } from "../../app/queries";
import { ModalDialog } from "../modal-dialog";
import { TextParts } from "../text-parts";
import { FollowSteps } from "./follow-steps";
import { RefusalNote } from "./refusal-note";

/**
 * The Add by URL dialog. The form asks for the address and the name, and
 * "Check server" creates the server, which asks it what it needs. The dialog
 * then follows the server (see `FollowSteps`): no sign-in ends it at once, a
 * server that needs a token gets the token form, and a server that cannot be
 * reached says so.
 *
 * - The name starts as the one the controller will choose for the address,
 *   and the user's own name survives edits of the address.
 * - A refusal (the address is added already, or a plugin offers that server)
 *   shows in the form, with the button that leads on. It stays only while the
 *   fields are as they were when it was made.
 * - Closing after "Check server" keeps the server: the check created it.
 *
 * `onShowOfferRow` is how the list shows the row of a plugin's offer, for the
 * button of the plugin refusal.
 */
export function AddByUrlDialog({
  client,
  onClose,
  onShowOfferRow,
}: {
  readonly client: HerculeClient;
  readonly onClose: () => void;
  readonly onShowOfferRow: (contributionId: string, connectionId: string) => void;
}): JSX.Element {
  const flow = useUrlServerFlow(client, { kind: "add" });
  const { state } = flow;
  // The fields live here, not in the form, because the form leaves the screen while the check runs and comes back with a refusal.
  const [address, setAddress] = useState("");
  // `null` while the user never typed a name: the suggestion then follows the address.
  const [typedName, setTypedName] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Fields | null>(null);
  return (
    <ModalDialog title="Add an MCP server by URL" onClose={onClose}>
      {state.kind === "form" ? (
        <AddForm
          client={client}
          fields={{ address, typedName }}
          submitted={submitted}
          problem={state.problem}
          onChange={(next) => {
            setAddress(next.address);
            setTypedName(next.typedName);
          }}
          onSubmit={(fields) => {
            setSubmitted(fields);
            flow.submitAdd(fields);
          }}
          onClose={onClose}
          onShowOfferRow={onShowOfferRow}
        />
      ) : (
        <FollowSteps
          flow={flow}
          state={state}
          fallbackServer={null}
          openedOn="elsewhere"
          onClose={onClose}
        />
      )}
    </ModalDialog>
  );
}

/** What the form's two fields hold. */
interface Fields {
  readonly address: string;
  readonly typedName: string | null;
}

/**
 * The Add form: the two fields, and the refusal of the last submit while the
 * fields are as they were sent. `submitted` holds the fields of that submit.
 */
function AddForm({
  client,
  fields,
  submitted,
  problem,
  onChange,
  onSubmit,
  onClose,
  onShowOfferRow,
}: {
  readonly client: HerculeClient;
  readonly fields: Fields;
  readonly submitted: Fields | null;
  readonly problem: FlowProblem | null;
  readonly onChange: (fields: Fields) => void;
  readonly onSubmit: (fields: Fields) => void;
  readonly onClose: () => void;
  readonly onShowOfferRow: (contributionId: string, connectionId: string) => void;
}): JSX.Element {
  const { address, typedName } = fields;
  const plugins = useQuery(pluginsQuery(client)).data;
  const connections = useQuery(connectionsQuery(client)).data?.items;
  const form = readAddForm({ address, typedName });

  // A problem was made for the fields as they were sent, so it goes once they change.
  const current =
    submitted !== null && submitted.address === address && submitted.typedName === typedName;
  const shown = current ? problem : null;
  const refusal: RefusalDescription | null =
    shown?.kind === "exists"
      ? describeExistsRefusal(shown.mcpServerId, shown.existing)
      : shown?.kind === "plugin-origin"
        ? describePluginOriginRefusal({
            refusal: shown.refusal,
            message: shown.message,
            plugins,
            connections,
          })
        : null;
  const issues = shown?.kind === "invalid" ? shown.issues : null;
  const generalProblem = shown?.kind === "failed" ? shown.message : (issues?.other ?? undefined);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!form.canSubmit) return;
        onSubmit({ address, typedName });
      }}
    >
      <Field id="mcp-url-address" label="Address" error={issues?.address ?? undefined}>
        <Input
          id="mcp-url-address"
          autoFocus
          spellCheck={false}
          placeholder="https://mcp.example.com/mcp"
          value={address}
          onChange={(event) => {
            onChange({ address: event.target.value, typedName });
          }}
        />
        <p className="text-fine text-faint">{ADDRESS_FIELD_HINT}</p>
      </Field>
      {refusal === null ? null : (
        <RefusalNote description={refusal} onLeave={onClose} onShowOfferRow={onShowOfferRow} />
      )}
      <Field id="mcp-url-name" label="Name" error={form.nameIssue ?? issues?.name ?? undefined}>
        <Input
          id="mcp-url-name"
          className="font-mono"
          spellCheck={false}
          value={typedName ?? form.name}
          placeholder={form.name}
          onChange={(event) => {
            onChange({ address, typedName: event.target.value });
          }}
        />
        <p className="text-fine text-faint">
          <TextParts parts={form.preview} />
        </p>
      </Field>
      {generalProblem === undefined ? null : (
        <p className="text-fine text-fail" role="alert">
          {generalProblem}
        </p>
      )}
      <div className="flex items-center justify-end gap-1.5 border-t border-line-soft pt-3">
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="form" disabled={!form.canSubmit}>
          Check server
        </Button>
      </div>
    </form>
  );
}
