/**
 * PROTOTYPE - the office's variants, by the key the variant bar switches.
 */
import type { BuildOfficeLayout } from "../engine/contracts";
import type { VariantKey } from "../office-store";
import { buildBureau } from "./bureau";

export const LAYOUTS: Readonly<Record<VariantKey, BuildOfficeLayout>> = {
  A: buildBureau,
  B: buildBureau,
  C: buildBureau,
};
