/**
 * PROTOTYPE - variant C, the Campus. STUB: the bureau floor, until the campus
 * layout part replaces it. Keep the exported signature.
 */
import type { BuildOfficeLayout } from "../engine/contracts";
import { buildBureau } from "./bureau";

export const buildCampus: BuildOfficeLayout = (context) => buildBureau(context);
