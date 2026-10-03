/**
 * PROTOTYPE - variant B, the Tower. STUB: the bureau floor, until the tower
 * layout part replaces it. Keep the exported signature.
 */
import type { BuildOfficeLayout } from "../engine/contracts";
import { buildBureau } from "./bureau";

export const buildTower: BuildOfficeLayout = (context) => buildBureau(context);
