/**
 * The surface a plugin programs against: its manifest, its two hooks, the
 * capability-sliced services the host hands them, and the contributions they
 * register. A plugin package depends on this and on `effect`, and reaches no
 * controller internal, so the same plugin runs out-of-process later.
 */
export * from "./manifest";
export * from "./config-schema";
export * from "./contributions";
export * from "./plugin";
