/**
 * Board ranks: the strings that order the cards of one cell of the Work board.
 *
 * A rank is a string of digits from the 62 characters `0-9A-Za-z`, in ASCII
 * order, read as a fraction between 0 and 1 (so `"V"` is a half). A rank never
 * ends in `0`, so each fraction has one spelling and comparing two ranks as
 * strings agrees with comparing them as fractions. This holds with SQLite's
 * default `BINARY` collation and with JavaScript's `<`.
 *
 * Putting a card between two others needs one new rank, so a move normally
 * writes one row. Repeated inserts into one gap make ranks longer. A rank is
 * at most `MAX_BOARD_RANK_LENGTH` characters, and `chooseRankBetween` reports
 * when a rank would pass that, so the caller can spread the cell again with
 * `spreadBoardRanks`.
 *
 * This module has no dependency.
 */

/** The digits of a rank, in ascending order. */
export const BOARD_RANK_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** The longest rank a cell may hold. */
export const MAX_BOARD_RANK_LENGTH = 64;

const BASE = BOARD_RANK_ALPHABET.length;
const ZERO_DIGIT = BOARD_RANK_ALPHABET[0]!;
const LAST_DIGIT = BOARD_RANK_ALPHABET[BASE - 1]!;

const readDigit = (character: string): number => BOARD_RANK_ALPHABET.indexOf(character);

/**
 * Returns a rank strictly between `low` and `high`. An empty `low` stands for
 * 0 and an absent `high` for 1. `low` must be below `high`, and neither may
 * end in `0`. The result never ends in `0`, and has no length limit.
 */
const findMidpoint = (low: string, high: string | undefined): string => {
  if (high !== undefined) {
    // Skip the digits both share (reading a missing digit of `low` as 0), and
    // find a rank between what is left.
    let shared = 0;
    while ((low[shared] ?? ZERO_DIGIT) === high[shared]) shared++;
    if (shared > 0) {
      return high.slice(0, shared) + findMidpoint(low.slice(shared), high.slice(shared));
    }
  }
  const lowDigit = low === "" ? 0 : readDigit(low[0]!);
  const highDigit = high === undefined ? BASE : readDigit(high[0]!);
  if (highDigit - lowDigit > 1) {
    return BOARD_RANK_ALPHABET[Math.round((lowDigit + highDigit) / 2)]!;
  }
  // The first digits are next to each other.
  if (high !== undefined && high.length > 1) return high.slice(0, 1);
  // `high` is absent or a single digit, so the first digit of `low` is the
  // one below it. Keep that digit and look for a rank above the rest of `low`.
  return BOARD_RANK_ALPHABET[lowDigit]! + findMidpoint(low.slice(1), undefined);
};

/** Returns a short rank above `low`; an empty `low` stands for 0. */
const findRankAbove = (low: string): string => {
  if (low === "") return findMidpoint("", undefined);
  const digit = readDigit(low[0]!);
  if (digit < BASE - 1) return BOARD_RANK_ALPHABET[digit + 1]!;
  return LAST_DIGIT + findRankAbove(low.slice(1));
};

/** Returns a short rank below `high`, which is not `"0"` or empty. */
const findRankBelow = (high: string): string => {
  const digit = readDigit(high[0]!);
  // A digit of 2 or more has a nonzero digit below it, and that single digit
  // is below every rank that starts with `high`'s first digit.
  if (digit >= 2) return BOARD_RANK_ALPHABET[digit - 1]!;
  // Any rank that starts with 0 and goes on is below a rank that starts with 1.
  if (digit === 1) return ZERO_DIGIT + findMidpoint("", undefined);
  // A rank cannot end in 0, so `high` goes on after its first digit.
  return ZERO_DIGIT + findRankBelow(high.slice(1));
};

/**
 * Returns a rank strictly between `before` and `after`, or `undefined` when
 * there is none to give. `before` or `after` is absent for the first or the
 * last place of a cell, and both are absent for the only card of a cell.
 *
 * It returns `undefined` when the result would be longer than
 * `MAX_BOARD_RANK_LENGTH`, and when `before` is not below `after`. Either way
 * the caller spreads the ranks of the cell again with `spreadBoardRanks` and
 * asks once more. Placing a card first or last grows a rank slowly, by one
 * character per 31 inserts at most; placing it into a gap grows it by one bit
 * per insert.
 */
export const chooseRankBetween = (
  before: string | undefined,
  after: string | undefined,
): string | undefined => {
  if (before !== undefined && after !== undefined && before >= after) return undefined;
  const rank =
    after === undefined
      ? findRankAbove(before ?? "")
      : before === undefined
        ? findRankBelow(after)
        : findMidpoint(before, after);
  return rank.length > MAX_BOARD_RANK_LENGTH ? undefined : rank;
};

/**
 * Returns `count` ranks in ascending order, spread evenly over the whole
 * range, with room left between them and at both ends. It is the ranks a cell
 * gets when its cards are given new ranks without changing their order.
 */
export const spreadBoardRanks = (count: number): ReadonlyArray<string> => {
  if (count === 0) return [];
  // The ranks get one digit more than they need to tell them apart, so a
  // card can be put between two of them before any rank grows.
  let width = 1;
  while (BASE ** width < (count + 1) * BASE) width++;
  const unit = BASE ** width;
  return Array.from({ length: count }, (_, index) => {
    let value = Math.floor(((index + 1) * unit) / (count + 1));
    let digits = "";
    for (let place = 0; place < width; place++) {
      digits = BOARD_RANK_ALPHABET[value % BASE]! + digits;
      value = Math.floor(value / BASE);
    }
    return digits.replace(/0+$/, "");
  });
};
