/**
 * The licence text of the copied ACP client, imported as a string.
 *
 * Bun embeds a file imported with `with { type: "text" }` in the compiled
 * binary. TypeScript has no type for a file without an extension, so it is
 * declared here.
 */
declare module "@hercule/acp/LICENSE" {
  const text: string;
  export default text;
}
