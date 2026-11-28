import { useRef, useState, type JSX } from "react";
import type { HerculeClient } from "@hercule/client-core";
import { GlassDialog } from "../glass-dialog";
import { CredentialFieldEntry } from "./provider-login";
import "./provider-login.css";

/**
 * Renders the dialog that replaces the key of the Provider Account
 * `providerAccountId`, called `name`: the key's field and Save, which are the
 * first run's entry of a credential field. The controller checks the key with
 * its provider before it stores it, so a refused key shows under the field and
 * the old key stays. While it checks, Esc and a click on the scrim do nothing,
 * so the key is never replaced after the user thought they had cancelled.
 *
 * `field` is the account's kind's credential field, such as the Z.ai API key.
 * The dialog closes after the new key is stored. `onClose` is called whenever
 * it closes, stored or not; the caller then unmounts it.
 */
export function ReplaceKeyDialog({
  client,
  providerAccountId,
  name,
  field,
  onClose,
}: {
  readonly client: HerculeClient;
  readonly providerAccountId: string;
  readonly name: string;
  readonly field: { readonly name: string; readonly title: string; readonly description: string };
  readonly onClose: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState(false);
  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="login-dialog"
      label={`Replace the key of ${name}`}
      locked={saving}
      onClose={onClose}
    >
      <div className="pop-h">
        <b>Replace the key of {name}</b>
      </div>
      <div className="pop-sec login-dialog-body">
        <CredentialFieldEntry
          client={client}
          providerAccountId={providerAccountId}
          field={field}
          onSaved={() => dialogRef.current?.close()}
          onPendingChange={setSaving}
        />
      </div>
    </GlassDialog>
  );
}
