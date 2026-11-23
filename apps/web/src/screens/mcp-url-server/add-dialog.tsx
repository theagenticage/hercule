import { useState, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import {
  ADDRESS_FIELD_HINT,
  describeUrlServerDialogTitle,
  describeUrlServerStep,
  readAddForm,
  type AddFields,
  type UrlServerDialog,
  type UrlServerStep,
} from "@hercule/client-core/mcp-servers";
import { Button, Field, Input } from "@hercule/ui";
import { useUrlServerAttempt } from "../../app/mcp-url-server-flow";
import { connectionsQuery, pluginsQuery } from "../../app/queries";
import { ModalDialog } from "../modal-dialog";
import { TextParts } from "../text-parts";
import { RefusalNote } from "./refusal-note";
import { StepView } from "./step-view";

/**
 * The Add by URL dialog. The form asks for the address and the name, and
 * "Check server" creates the server, which asks it what it needs. The dialog
 * then draws the steps of its attempt (see `StepView`): no sign-in ends it at
 * once, a server that needs a token gets the token form, and a server that
 * cannot be reached says so.
 *
 * - The name starts as the one the controller will choose for the address,
 *   and the user's own name survives edits of the address.
 * - A refusal (the address is added already, or a plugin offers that server)
 *   shows in the form, with the button that leads on. The attempt keeps it
 *   only while the fields are as they were when it was made.
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
  const { attempt, state } = useUrlServerAttempt(client, { kind: "add" });
  const plugins = useQuery(pluginsQuery(client)).data;
  const connections = useQuery(connectionsQuery(client)).data?.items;
  const dialog: UrlServerDialog = { kind: "add", plugins, connections, pluginsSettings: "here" };
  const step = describeUrlServerStep(state, dialog);
  // The fields live here, not in the form, because the form leaves the screen while the check runs and comes back with a refusal.
  const [address, setAddress] = useState("");
  // `null` while the user never typed a name: the suggestion then follows the address.
  const [typedName, setTypedName] = useState<string | null>(null);
  const [title] = useState(() => describeUrlServerDialogTitle(dialog));
  return (
    <ModalDialog title={title} onClose={onClose}>
      {step.kind === "add-form" ? (
        <AddForm
          step={step}
          fields={{ address, typedName }}
          onChange={(next) => {
            setAddress(next.address);
            setTypedName(next.typedName);
            attempt.changeFields(next);
          }}
          onSubmit={attempt.submitAdd}
          onClose={onClose}
          onShowOfferRow={onShowOfferRow}
        />
      ) : (
        <StepView step={step} attempt={attempt} onClose={onClose} />
      )}
    </ModalDialog>
  );
}

/** The Add form: the two fields, and what the attempt says of the last refusal. */
function AddForm({
  step,
  fields,
  onChange,
  onSubmit,
  onClose,
  onShowOfferRow,
}: {
  readonly step: Extract<UrlServerStep, { kind: "add-form" }>;
  readonly fields: AddFields;
  readonly onChange: (fields: AddFields) => void;
  readonly onSubmit: (fields: AddFields) => void;
  readonly onClose: () => void;
  readonly onShowOfferRow: (contributionId: string, connectionId: string) => void;
}): JSX.Element {
  const { address, typedName } = fields;
  const form = readAddForm({ address, typedName });
  const { refusal } = step;

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!form.canSubmit) return;
        onSubmit({ address, typedName });
      }}
    >
      <Field id="mcp-url-address" label="Address" error={step.addressIssue ?? undefined}>
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
      <Field id="mcp-url-name" label="Name" error={form.nameIssue ?? step.nameIssue ?? undefined}>
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
      {step.problemText === null ? null : (
        <p className="text-fine text-fail" role="alert">
          {step.problemText}
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
