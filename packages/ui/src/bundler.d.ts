/**
 * The one thing the bundler adds to the module system that this package uses.
 *
 * `@hercule/ui` takes no build of its own - it is imported as source - so it
 * links no bundler's types, and `import.meta.glob` is declared here instead.
 */
interface ImportMeta {
  readonly glob: (
    pattern: string,
    options?: {
      readonly query?: string;
      readonly import?: string;
      readonly eager?: boolean;
    },
  ) => Record<string, unknown>;
}

/** A stylesheet imported for its source rather than for its effect. */
declare module "*.css?raw" {
  const source: string;
  export default source;
}
