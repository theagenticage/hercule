import "react";

declare module "react" {
  interface CSSProperties {
    /**
     * The hue a face is drawn in, as `var(--hue-<hue>)`. tokens.css derives
     * `--who` and its shades from it for any element whose `style` attribute
     * holds `--hue`.
     */
    "--hue"?: string;
  }
}
