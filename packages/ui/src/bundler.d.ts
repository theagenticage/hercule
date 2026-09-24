/**
 * The one bundler feature this package uses that plain TypeScript does not know.
 *
 * `@hercule/ui` has no build of its own - it is imported as source - so it does
 * not depend on any bundler's types, and `import.meta.glob` is declared here
 * instead.
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

/** A stylesheet imported as a text string, instead of being applied to the page. */
declare module "*.css?raw" {
  const source: string;
  export default source;
}
