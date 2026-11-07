import "react";

declare module "react" {
  interface CSSProperties {
    /** Where in its 3.4 second cycle a card's paws start, as a negative delay, so cards do not tap in step. */
    "--paw-delay"?: string;
    /** How long after the sunrise starts one of its rays starts to grow. */
    "--ray-delay"?: string;
    /** The width of a sunrise that stands in the flow of a page, and its face and the box that clips the face. */
    "--sunrise-width"?: string;
    "--face-size"?: string;
    "--face-box-height"?: string;
    /** The distance a pane's width is shifted for the undo line, so it stays centred on the board. */
    "--undo-line-x"?: string;
  }
}
