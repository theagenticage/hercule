/**
 * A minimal model of a terminal screen, used to read what a program shows in a
 * pseudo-terminal.
 *
 * A program with a full-screen or inline text UI (Ink, for one) does not print
 * lines. It repaints: it moves the cursor, erases, and writes only the cells
 * that changed, so the word `code` can arrive as `c`, a cursor move, and
 * `de`. Stripping the escape sequences from such output garbles the text.
 * This class applies the sequences instead, so the cells hold what a person
 * looking at the terminal would read.
 *
 * It supports what inline text UIs use: printing, carriage return, line feed,
 * backspace, tab, relative and column cursor moves (`CSI A B C D E F G`), and
 * line and screen erase (`CSI K J`). Colours and modes (`CSI ... m h l`),
 * hyperlinks and window titles (`OSC`), and every other sequence are skipped.
 * The screen has no fixed height: a line is never scrolled away, up to
 * `MAX_ROWS`, and the cursor never moves above the first line. Every character
 * takes one cell.
 */

/** The most lines kept. The oldest are dropped, which a person would see as scrolling off. */
const MAX_ROWS = 500;

/** The most bytes of an unfinished escape sequence kept while waiting for the rest of it. */
const MAX_PENDING = 8192;

const TAB_WIDTH = 8;

export class TerminalScreen {
  private readonly columns: number;
  private rows: Array<Array<string>> = [[]];
  /** For each row, whether it continues the row above it because the text wrapped at the last column. */
  private continues: Array<boolean> = [false];
  private row = 0;
  private column = 0;
  /** The start of an escape sequence that the last `feed` ended in the middle of. */
  private pending = "";

  constructor(columns: number) {
    this.columns = columns;
  }

  /**
   * Applies terminal output to the screen. An escape sequence cut off at the
   * end of `text` is kept and finished by the next call, so the output may be
   * fed in chunks of any size.
   */
  feed(text: string): void {
    const input = this.pending + text;
    this.pending = "";
    let index = 0;
    while (index < input.length) {
      const char = input[index]!;
      if (char === "\u001b") {
        const end = this.findSequenceEnd(input, index);
        if (end === undefined) {
          if (input.length - index <= MAX_PENDING) this.pending = input.slice(index);
          return;
        }
        this.applySequence(input.slice(index, end));
        index = end;
        continue;
      }
      // A code point, not a UTF-16 unit, is one cell.
      const point = String.fromCodePoint(input.codePointAt(index)!);
      index += point.length;
      this.applyCharacter(point);
    }
  }

  /**
   * Returns the text of the screen, one string per line, as it reads. A line
   * that wrapped at the last column is joined to the line it wrapped from, with
   * nothing between the two parts. Trailing spaces are removed.
   */
  readLines(): ReadonlyArray<string> {
    return this.joinWrappedRows().map((line) => line.text);
  }

  /**
   * Returns the lines of `readLines` that the cursor has moved past. The line
   * the cursor is on, or that it could still reach by moving up, is left out:
   * the program may not have finished writing it, and a reader that takes it
   * for complete would read half a URL.
   */
  readFinishedLines(): ReadonlyArray<string> {
    return this.joinWrappedRows()
      .filter((line) => line.lastRow < this.row)
      .map((line) => line.text);
  }

  /** Returns each line with the index of the last row it takes. */
  private joinWrappedRows(): ReadonlyArray<{ readonly text: string; readonly lastRow: number }> {
    const lines: Array<{ text: string; lastRow: number }> = [];
    this.rows.forEach((cells, index) => {
      const text = cells.join("");
      const last = lines.at(-1);
      if (this.continues[index] === true && last !== undefined) {
        last.text = `${last.text.trimEnd()}${text}`;
        last.lastRow = index;
      } else {
        lines.push({ text, lastRow: index });
      }
    });
    return lines.map((line) => ({ text: line.text.trimEnd(), lastRow: line.lastRow }));
  }

  /**
   * Returns the index just past the escape sequence that starts at `start`, or
   * `undefined` when the input ends before the sequence does.
   */
  private findSequenceEnd(input: string, start: number): number | undefined {
    const kind = input[start + 1];
    if (kind === undefined) return undefined;
    if (kind === "[") {
      // Parameter bytes, intermediate bytes, then one final byte.
      const final = /[@-~]/.exec(input.slice(start + 2));
      return final === null ? undefined : start + 2 + final.index + 1;
    }
    if (kind === "]") {
      // A string ending in BEL or in ESC followed by a backslash.
      const rest = input.slice(start + 2);
      const bell = rest.indexOf("\u0007");
      const terminator = rest.indexOf("\u001b\\");
      if (bell === -1 && terminator === -1) return undefined;
      if (terminator === -1 || (bell !== -1 && bell < terminator)) return start + 2 + bell + 1;
      return start + 2 + terminator + 2;
    }
    // ESC, any intermediate bytes (such as the `(` of a character set), then one final byte.
    const final = /[0-~]/.exec(input.slice(start + 1));
    return final === null ? undefined : start + 1 + final.index + 1;
  }

  private applySequence(sequence: string): void {
    if (!sequence.startsWith("\u001b[")) return;
    const final = sequence.at(-1)!;
    const parameters = sequence.slice(2, -1);
    const first = Number.parseInt(parameters.split(";")[0] ?? "", 10);
    // A missing or zero count means one. A huge count is cut to what the screen
    // can hold, so a hostile program cannot make the runner loop or allocate
    // for billions of rows or cells.
    const count = Math.min(Number.isNaN(first) || first === 0 ? 1 : first, this.largestMove());
    switch (final) {
      case "A":
        this.moveRow(-count);
        break;
      case "B":
        this.moveRow(count);
        break;
      case "C":
        this.column = Math.min(this.column + count, this.columns);
        break;
      case "D":
        this.column = Math.max(0, this.column - count);
        break;
      case "E":
        this.moveRow(count);
        this.column = 0;
        break;
      case "F":
        this.moveRow(-count);
        this.column = 0;
        break;
      case "G":
        this.column = Math.min(count - 1, this.columns);
        break;
      case "K":
        this.eraseLine(Number.isNaN(first) ? 0 : first);
        break;
      case "J":
        this.eraseScreen(Number.isNaN(first) ? 0 : first);
        break;
      default:
        break;
    }
  }

  /** Returns the longest cursor move that can matter: the wider of the rows kept and the columns. */
  private largestMove(): number {
    return Math.max(MAX_ROWS, this.columns);
  }

  private applyCharacter(char: string): void {
    switch (char) {
      case "\r":
        this.column = 0;
        return;
      case "\n":
        this.moveRow(1);
        return;
      case "\b":
        this.column = Math.max(0, this.column - 1);
        return;
      case "\t":
        this.column = Math.min((Math.floor(this.column / TAB_WIDTH) + 1) * TAB_WIDTH, this.columns);
        return;
      default:
        break;
    }
    if (char < " " || char === "\u007f") return;
    if (this.column >= this.columns) {
      this.moveRow(1);
      this.continues[this.row] = true;
      this.column = 0;
    }
    const cells = this.rows[this.row]!;
    while (cells.length < this.column) cells.push(" ");
    cells[this.column] = char;
    this.column += 1;
  }

  /** Moves the cursor down (positive) or up (negative), adding lines below and never going above the first. */
  private moveRow(by: number): void {
    this.row = Math.max(0, this.row + by);
    while (this.rows.length <= this.row) {
      this.rows.push([]);
      this.continues.push(false);
    }
    if (this.rows.length > MAX_ROWS) {
      const dropped = this.rows.length - MAX_ROWS;
      this.rows = this.rows.slice(dropped);
      this.continues = this.continues.slice(dropped);
      this.row = Math.max(0, this.row - dropped);
    }
  }

  /** Erases to the end of the line (0), to the start of it (1), or all of it (2). */
  private eraseLine(mode: number): void {
    const cells = this.rows[this.row]!;
    if (mode === 0) cells.length = Math.min(cells.length, this.column);
    else if (mode === 1) for (let cell = 0; cell <= this.column; cell += 1) cells[cell] = " ";
    else if (mode === 2) cells.length = 0;
  }

  /** Erases from the cursor to the end of the screen (0), or the whole screen (2 and 3). */
  private eraseScreen(mode: number): void {
    if (mode === 0) {
      this.eraseLine(0);
      for (let row = this.row + 1; row < this.rows.length; row += 1) this.rows[row] = [];
    } else if (mode === 2 || mode === 3) {
      this.rows = this.rows.map(() => []);
    }
  }
}
