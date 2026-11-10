/**
 * What a plugin may give the apps to draw: small icons as SVG path data, and
 * the colour to draw them in. The apps draw both themselves, so a plugin never
 * ships an SVG, a script or a style.
 *
 * One colour type serves the plugin's mark and the icons of its statuses:
 *
 * - `hue`: an angle on the colour wheel. The theme decides how light and how
 *   strong the colour is, so it reads well in every theme.
 * - `color`: an exact CSS colour, either one for every theme or a pair for
 *   light and dark themes.
 * - neither: the mark takes the text colour, and a status icon is grey.
 */
import { Schema } from "effect";

/** The characters SVG path data is written with: commands, digits, signs and separators. */
export const SVG_PATH_DATA_PATTERN = /^[MmZzLlHhVvCcSsQqTtAa0-9eE.,+\-\s]+$/;

/**
 * The most paths one icon may have. A 16x16 icon needs a handful, and the
 * apps draw every path wherever the icon appears.
 */
export const MAX_ICON_PATHS = 16;

/** The most bytes of UTF-8 all of one icon's paths may hold together. A 16x16 icon needs a few hundred. */
export const MAX_ICON_BYTES = 4 * 1024;

/**
 * Returns why the paths of an icon cannot be drawn, in one sentence, or
 * `undefined` when they can: there is at least one path and at most
 * `MAX_ICON_PATHS`, every path is SVG path data, and together they hold at
 * most `MAX_ICON_BYTES`.
 *
 * The apps put each path into the `d` attribute of an SVG `<path>`, so only
 * path data is let through. Anything else could break out of the attribute.
 */
export const findIconPathsProblem = (paths: ReadonlyArray<string>): string | undefined => {
  if (paths.length === 0) return "it has no paths";
  if (paths.length > MAX_ICON_PATHS) {
    return `it has ${String(paths.length)} paths, and an icon may have at most ${String(MAX_ICON_PATHS)}`;
  }
  const bytes = paths.reduce((total, path) => total + new TextEncoder().encode(path).byteLength, 0);
  if (bytes > MAX_ICON_BYTES) return "its paths together are larger than 4 KB";
  if (!paths.every((path) => SVG_PATH_DATA_PATTERN.test(path))) {
    return "one of its paths holds something other than SVG path data";
  }
  return undefined;
};

/**
 * An icon a plugin draws for one of its statuses: SVG path data on a fixed
 * 16x16 grid, filled in the status's colour, like a plugin's mark.
 */
export const StatusIcon = Schema.Struct({
  paths: Schema.Array(Schema.String).check(
    Schema.makeFilter((paths: ReadonlyArray<string>) => {
      const problem = findIconPathsProblem(paths);
      return problem === undefined ? undefined : `The icon cannot be drawn: ${problem}.`;
    }),
  ),
});

export type StatusIcon = Schema.Schema.Type<typeof StatusIcon>;

/**
 * A CSS colour: a hex code such as `#8250df`, or a CSS colour name such as
 * `purple`. The host checks a name against the CSS list when the plugin
 * loads, and turns it into its hex code, so the apps only ever receive hex.
 * `rgb()`, `hsl()` and the other colour functions are not accepted.
 */
export const CssColor = Schema.String.check(
  Schema.isPattern(/^(?:#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})|[a-zA-Z]+)$/, {
    message: 'A colour is a hex code such as "#8250df" or a CSS colour name such as "purple".',
  }),
);

/** An exact colour: one for every theme, or one for light themes and one for dark themes. */
export const ExactColor = Schema.Union([
  CssColor,
  Schema.Struct({ light: CssColor, dark: CssColor }),
]);

export type ExactColor = Schema.Schema.Type<typeof ExactColor>;

/** An angle on the colour wheel, in degrees. */
export const Hue = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 360 }));

/**
 * Returns the schema of `fields` plus a colour: `hue`, `color`, or neither,
 * never both. The decoded type is a union, so TypeScript refuses an object
 * that sets both, and so does decoding.
 */
export const withPluginColor = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Union([
    Schema.Struct({ ...fields, hue: Hue, color: Schema.optionalKey(Schema.Never) }),
    Schema.Struct({ ...fields, color: ExactColor, hue: Schema.optionalKey(Schema.Never) }),
    Schema.Struct({
      ...fields,
      hue: Schema.optionalKey(Schema.Never),
      color: Schema.optionalKey(Schema.Never),
    }),
  ]);
