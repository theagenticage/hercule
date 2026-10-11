/** How this plugin fits text it writes into the limits the host checks. */

/** Cuts text to `maximum` characters, ending it with an ellipsis when it was cut. */
export const cutText = (text: string, maximum: number): string =>
  text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
