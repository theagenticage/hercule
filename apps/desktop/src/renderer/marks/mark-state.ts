import type { Pose } from "@hercule/client-core";

/** The six poses that have a mark. Asleep and away have none. */
export type MarkState = Exclude<Pose, "asleep" | "away">;
