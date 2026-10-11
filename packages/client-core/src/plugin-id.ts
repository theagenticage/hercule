/**
 * Returns the id of the plugin that owns `id`, an id a plugin qualifies with
 * its own as `<pluginId>/<word>`: `github` for the signal kind
 * `github/mentioned` and for the workflow action `github/pr.create`. Returns
 * null for an id the core owns, which has no "/": a core signal kind such as
 * `proposal`, or a built-in action such as `task.create`.
 */
export const parsePluginId = (id: string): string | null => {
  const slash = id.indexOf("/");
  return slash === -1 ? null : id.slice(0, slash);
};
