import type { Theme } from "../../../../ipc/appearance";

/** The name the Appearance page shows for each theme. */
export const THEME_NAMES: { readonly [Name in Theme]: string } = {
  whitehaven: "Whitehaven",
  styles: "Styles",
  "orient-express": "Orient Express",
  nile: "Nile",
  "end-house": "End House",
};
