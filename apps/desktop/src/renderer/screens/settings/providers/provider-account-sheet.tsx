import type { JSX, ReactNode, RefObject } from "react";
import type { ProviderAccountIdentityLine } from "@hercule/client-core";
import { CloseIcon } from "../../../icons/close";
import { GlassDialog } from "../../glass-dialog";
import { IdentityLine } from "./identity-line";
import "./providers.css";

/**
 * Renders the account sheet: a glass dialog over the Providers page,
 * titled with the account's `name`, with its provider's `mark` and the
 * `identity` line beside the title. `children` are the sheet's sections
 * (`ProviderAccountSheetSection`). The close button, Done, Esc and a click on the
 * scrim close it; `onClose` is called whenever it closes, and the caller then
 * unmounts it.
 */
export function ProviderAccountSheet({
  dialogRef,
  mark,
  name,
  identity,
  onClose,
  children,
}: {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly mark: ReactNode;
  readonly name: string;
  readonly identity: ProviderAccountIdentityLine;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  const close = (): void => dialogRef.current?.close();
  return (
    <GlassDialog dialogRef={dialogRef} className="account-sheet" label={name} onClose={onClose}>
      <div className="pa-sheet-h">
        <span className="pa-sheet-mark">{mark}</span>
        <span className="pa-sheet-title">
          <h2>{name}</h2>
          <IdentityLine line={identity} className="pa-sheet-identity" />
        </span>
        <button type="button" className="icon-btn" title="Close" aria-label="Close" onClick={close}>
          <CloseIcon size={14} />
        </button>
      </div>
      <div className="pa-sheet-b">{children}</div>
      <div className="pa-sheet-f">
        <button type="button" className="btn" onClick={close}>
          Done
        </button>
      </div>
    </GlassDialog>
  );
}

/** Renders one section of the account sheet: its heading, then `children`. */
export function ProviderAccountSheetSection({
  heading,
  children,
}: {
  readonly heading: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className="pa-sec">
      <h3>{heading}</h3>
      {children}
    </section>
  );
}
