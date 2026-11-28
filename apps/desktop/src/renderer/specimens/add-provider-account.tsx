/**
 * The add-account sheet specimen: the sheet alone, open over the page, drawn
 * from one state of add-provider-account-fixture.ts. No capture script draws
 * it; open it in the dev server for a check by eye.
 *
 * The page takes its state from `?state=provider`, `kind`, `key`,
 * `key-checking`, `key-refused`, `label`, `sign-in` or `token`, and its theme from `?theme=`,
 * one of the six in sheet-themes.ts.
 */
import "../styles/base-layer.css";
import { createRef } from "react";
import { createRoot } from "react-dom/client";
import { AddProviderAccountSheet } from "../screens/settings/providers/add-provider-account-sheet";
import { ADD_ACCOUNT_STATES } from "./add-provider-account-fixture";
import { applySheetAppearance, markSheetReady } from "./sheet-page";

/** Returns the state the page's `?state=` names. Fails when it names none. */
function readState(): (typeof ADD_ACCOUNT_STATES)[string] {
  const name = new URLSearchParams(location.search).get("state") ?? "provider";
  const state = ADD_ACCOUNT_STATES[name];
  if (state === undefined) {
    throw new Error(
      `Unknown state "${name}" in the URL. Use one of: ${Object.keys(ADD_ACCOUNT_STATES).join(", ")}.`,
    );
  }
  return state;
}

applySheetAppearance();
createRoot(document.getElementById("root")!).render(
  <AddProviderAccountSheet dialogRef={createRef()} onClose={() => undefined} {...readState()} />,
);
// The dialog opens in an effect and focuses its first control, whose ring the
// page would draw although no key was pressed.
while (document.querySelector("dialog[open]") === null) {
  await new Promise((resolve) => requestAnimationFrame(resolve));
}
(document.activeElement as HTMLElement | null)?.blur();
const style = document.createElement("style");
style.textContent = "* { animation: none !important; }";
document.head.append(style);
await markSheetReady();
