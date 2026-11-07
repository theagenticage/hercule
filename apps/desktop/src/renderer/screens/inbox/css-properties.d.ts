import "react";

declare module "react" {
  interface CSSProperties {
    /** A card's place in its surface or list, which sets when its words fade in after the first read. */
    "--arrive-step"?: number;
    /** A surface's or a column's place on the page, which sets when its cards' words fade in. */
    "--arrive-block"?: number;
  }
}
