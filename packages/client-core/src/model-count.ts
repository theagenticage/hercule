// A module of its own because the composer's model menu and the provider
// rows both use it. The bundler places a whole module in one chunk, so if
// this stayed in `provider-rows.ts`, the provider rows would ship with the
// desktop app's first screen, which draws the model menu, although only the
// provider login dialog, loaded later, draws them.

/** Returns how many models an account has, in words: "no models", "1 model", "3 models". */
export const describeModelCount = (count: number): string => {
  if (count === 0) return "no models";
  return count === 1 ? "1 model" : `${String(count)} models`;
};
