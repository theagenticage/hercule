import "react";

declare module "react" {
  interface CSSProperties {
    /**
     * The colour a box of the Office is painted in. office.css shades the
     * box's three faces from it for any `.bx` whose `style` attribute holds `--c`.
     */
    "--c"?: string;
  }
}
