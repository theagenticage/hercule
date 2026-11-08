import { cutWithEllipsis } from "../text";

/** The most characters of a title that the undo line and a card's second line quote. */
const MOST_TITLE_CHARACTERS = 32;

/** Returns the title cut to `MOST_TITLE_CHARACTERS`, with an ellipsis when it was cut. */
export const shortenTitle = (title: string): string =>
  cutWithEllipsis(title, MOST_TITLE_CHARACTERS);
