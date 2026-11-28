import "react";

declare module "react" {
  interface CSSProperties {
    /** How long the empty state's sunrise waits before it draws, such as `240ms`. */
    "--sun-wait"?: string;
    /** How many rays from the middle one a sunrise ray is; the farther, the later it draws. */
    "--ray"?: number;
  }
}
