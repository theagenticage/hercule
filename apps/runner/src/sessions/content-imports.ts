/**
 * Recognises the shell commands that may write content from elsewhere into a
 * checkout: git operations that write the files of another commit, a stash or
 * a patch, such as `git merge` or `git checkout main -- f` (spec 19 section
 * 4.1). The edit watch credits nobody for what changes while such a command
 * runs, because nothing in a file's state tells content git wrote from an
 * edit the session made in the same call.
 *
 * The check errs towards recognising a command. A command counts when any of
 * its words is `git` followed by a subcommand listed below, wherever that word
 * stands: after `if`, `{`, `env -u X`, `nice -n 5` or `sudo -u user` alike.
 * Counting a command that imports nothing only drops the edits made in the
 * same call; missing one credits content to a session that never wrote it.
 *
 * The words are split the way a shell splits them, closely enough to keep out
 * git that is only named inside single quotes, a heredoc with a quoted
 * delimiter, or a comment. Git inside a command substitution, `$(...)` or
 * backquotes, counts, also within double quotes or an unquoted heredoc, and
 * so does git inside `sh -c '...'` and its relatives. Where the split is not
 * exact, it errs towards counting. The text is read twice, once with double
 * quotes as quotes and once as if they were not there, and a command counts
 * when either reading finds git: so quotes nested in a substitution cannot
 * hide it, and `echo "git merge main"` counts. Git named only in single
 * quotes, a quoted heredoc or a comment still does not. Git run by a script
 * file or an alias is not seen.
 */

/**
 * The git subcommands that can write content from another commit, a stash or
 * a patch into the working tree. A subcommand that moves HEAD to what it
 * writes, such as `switch`, `reset` or `rebase`, counts too: git writes the
 * files before it moves HEAD, and `rebase --autostash` writes back an edit
 * that was there before. A subcommand that writes nothing in some forms, such
 * as `git checkout -b new`, still counts: when nothing changes, nothing is
 * dropped. `revert` does not count, because a rollback is an edit the session
 * chose.
 */
const IMPORTING_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "am",
  "apply",
  "checkout",
  "cherry-pick",
  "merge",
  "pull",
  "rebase",
  "reset",
  "restore",
  "switch",
]);

/** The `git stash` actions that write a stash's files into the working tree. */
const IMPORTING_STASH_ACTIONS: ReadonlySet<string> = new Set(["apply", "branch", "pop"]);

/** The git global options that take the next word as their value. */
const GIT_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
]);

/** The shells whose `-c` option runs a later word as a script. */
const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/**
 * The characters that end a word and, outside quotes, separate two commands.
 * A command substitution's `$(`, `)` and backquotes are among them, so the
 * commands inside a substitution are read like any other command, without
 * matching where the substitution ends.
 */
const SEPARATORS: ReadonlySet<string> = new Set([";", "&", "|", "(", ")", "`", "\n"]);

/**
 * Removes the backslashes that a double-quoted string drops: before `$`, a
 * backquote, `"`, `\` and a newline, where a backslash and a newline join two
 * lines. Any other backslash stays.
 */
const unescapeDoubleQuoted = (text: string): string =>
  text.replace(/\\([$`"\\\n])/g, (_match, char: string) => (char === "\n" ? "" : char));

/** Checks whether text that the shell expands holds a command substitution. */
const holdsSubstitution = (text: string): boolean => text.includes("$(") || text.includes("`");

/**
 * One simple command: its words, and whether their boundaries may be wrong.
 * They may be in text read again from a double-quoted string or a heredoc,
 * where quotes are removed, so a quoted operand can turn into several words.
 */
interface SimpleCommand {
  readonly words: ReadonlyArray<string>;
  readonly uncertainWords: boolean;
}

/**
 * How a reading of shell text treats double quotes: as quotes, or as if they
 * were not there, so that quotes nested in a substitution cannot hide a
 * command.
 */
type DoubleQuotes = "quote" | "ignore";

/**
 * Splits shell text into its simple commands, each a list of words with the
 * quotes removed. Single quotes, ANSI-C quotes, backslashes, comments,
 * heredocs and here-strings are read the way a shell reads them. Where the
 * commands of a substitution end is not worked out: the text a shell would
 * expand, a double-quoted string or an unquoted heredoc body, is read again
 * as commands when it holds a substitution. A heredoc whose end line never
 * comes is not taken as one, so it cannot hide the commands after it. Never
 * throws.
 */
const splitCommands = (text: string, doubleQuotes: DoubleQuotes): ReadonlyArray<SimpleCommand> => {
  const commands: Array<SimpleCommand> = [];
  let words: Array<string> = [];
  let word: string | undefined;
  let wordWasQuoted = false;
  // The heredocs opened on the current line, whose bodies start on the next one.
  const heredocs: Array<{ delimiter: string; stripTabs: boolean; expands: boolean }> = [];
  let readingHeredocDelimiter: { stripTabs: boolean } | undefined;

  const extendWord = (part: string, quoted: boolean): void => {
    word = (word ?? "") + part;
    wordWasQuoted ||= quoted;
  };
  const endWord = (): void => {
    if (word === undefined) return;
    if (readingHeredocDelimiter === undefined) {
      words.push(word);
    } else {
      // A heredoc whose delimiter is quoted is taken literally; any other expands.
      heredocs.push({ delimiter: word, ...readingHeredocDelimiter, expands: !wordWasQuoted });
      readingHeredocDelimiter = undefined;
    }
    word = undefined;
    wordWasQuoted = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) commands.push({ words, uncertainWords: false });
    words = [];
  };
  /**
   * Reads text that the shell expands, a double-quoted string or an unquoted
   * heredoc body, again as commands when it holds a substitution. In such
   * text quotes and `#` are data, which must not hide a substitution after
   * them. So quotes are removed and `#` becomes a space first, and the words
   * read are marked as uncertain: a quoted operand may now be several words.
   */
  const readExpandedText = (expanded: string): void => {
    if (!holdsSubstitution(expanded)) return;
    const unquoted = expanded.replace(/['"]/g, "").replace(/#/g, " ");
    for (const command of splitCommands(unquoted, doubleQuotes)) {
      commands.push({ words: command.words, uncertainWords: true });
    }
  };
  /**
   * Skips the bodies of the heredocs opened on the line that ended just
   * before `from`, and returns the index after them. Each body ends with a
   * line that holds only its delimiter, with leading tabs removed for `<<-`.
   * When a body's end line never comes, the text from that body on is read
   * as commands instead.
   */
  const skipHeredocBodies = (from: number): number => {
    let at = from;
    for (const { delimiter, stripTabs, expands } of heredocs.splice(0)) {
      const bodyStart = at;
      let bodyEnd: number | undefined;
      while (at < text.length && bodyEnd === undefined) {
        const newline = text.indexOf("\n", at);
        const lineEnd = newline === -1 ? text.length : newline;
        const line = text.slice(at, lineEnd);
        if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) bodyEnd = at;
        at = lineEnd + 1;
      }
      if (bodyEnd === undefined) return bodyStart;
      if (expands) readExpandedText(text.slice(bodyStart, bodyEnd));
    }
    return at;
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (text.startsWith("$'", index)) {
      // An ANSI-C quote of bash and zsh, in which a backslash escapes the next
      // character, a quote included. Its escapes are not decoded: the word is
      // only compared with program names, and none holds a backslash.
      let close = index + 2;
      while (close < text.length && text[close] !== "'") close += text[close] === "\\" ? 2 : 1;
      extendWord(text.slice(index + 2, close), true);
      index = close + 1;
    } else if (text.startsWith('$"', index)) {
      // A translated string of bash and zsh, read as a double-quoted one.
      index += 1;
    } else if (char === '"' && doubleQuotes === "ignore") {
      index += 1;
    } else if (char === "'") {
      const close = text.indexOf("'", index + 1);
      const end = close === -1 ? text.length : close;
      extendWord(text.slice(index + 1, end), true);
      index = end + 1;
    } else if (char === '"') {
      let close = index + 1;
      while (close < text.length && text[close] !== '"') close += text[close] === "\\" ? 2 : 1;
      const quoted = text.slice(index + 1, close);
      // A heredoc's delimiter is never expanded, whatever it holds.
      if (readingHeredocDelimiter === undefined) readExpandedText(quoted);
      extendWord(unescapeDoubleQuoted(quoted), true);
      index = close + 1;
    } else if (char === "\\") {
      // A backslash before a newline joins two lines; before anything else it quotes it.
      if (text[index + 1] !== "\n") extendWord(text[index + 1] ?? "", true);
      index += 2;
    } else if (char === "#" && word === undefined) {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
    } else if (text.startsWith("<<<", index)) {
      // A here-string, which bash and zsh have: the next word is its input.
      endWord();
      index += 3;
    } else if (text.startsWith("<<", index)) {
      endWord();
      const stripTabs = text[index + 2] === "-";
      readingHeredocDelimiter = { stripTabs };
      index += stripTabs ? 3 : 2;
    } else if (char === " " || char === "\t") {
      endWord();
      index += 1;
    } else if (SEPARATORS.has(char)) {
      endCommand();
      index += 1;
      if (char === "\n" && heredocs.length > 0) index = skipHeredocBodies(index);
    } else {
      extendWord(char, false);
      index += 1;
    }
  }
  endCommand();
  return commands;
};

/**
 * Returns the program a word names: the last part of a path, so `/usr/bin/git`
 * reads as `git`, without the backquotes of an escaped, nested substitution
 * in front.
 */
const readProgramName = (word: string): string =>
  word.slice(word.lastIndexOf("/") + 1).replace(/^`+/, "");

/**
 * Checks whether the words after a `git` word name a subcommand that may
 * import content. With uncertain words, git's options cannot be told from
 * their operands, so any later word that is such a subcommand counts.
 */
const isImportingGitCall = (args: ReadonlyArray<string>, uncertainWords: boolean): boolean => {
  if (uncertainWords) {
    const names = args.map((arg) => arg.replace(/^\$/, ""));
    return (
      names.some((name) => IMPORTING_GIT_SUBCOMMANDS.has(name)) ||
      (names.includes("stash") && names.some((name) => IMPORTING_STASH_ACTIONS.has(name)))
    );
  }
  let at = 0;
  while (at < args.length && args[at]!.startsWith("-")) {
    at += GIT_OPTIONS_WITH_VALUE.has(args[at]!) ? 2 : 1;
  }
  const subcommand = args[at];
  if (subcommand === "stash") return IMPORTING_STASH_ACTIONS.has(args[at + 1] ?? "");
  return subcommand !== undefined && IMPORTING_GIT_SUBCOMMANDS.has(subcommand);
};

/**
 * Checks whether any word of one simple command starts a call that may import
 * content: `git` with a subcommand listed above, `gh pr checkout`, or a shell
 * whose `-c` script may.
 */
const hasImportingCall = ({ words, uncertainWords }: SimpleCommand): boolean =>
  words.some((word, at) => {
    const program = readProgramName(word);
    if (program === "git") return isImportingGitCall(words.slice(at + 1), uncertainWords);
    if (program === "gh") return words[at + 1] === "pr" && words[at + 2] === "checkout";
    if (!SHELLS.has(program)) return false;
    const option = words.findIndex((arg, after) => after > at && /^-[a-z]*c[a-z]*$/.test(arg));
    const script = option === -1 ? undefined : words[option + 1];
    return script !== undefined && mayImportContent(script);
  });

/**
 * Checks whether a shell command may write content from elsewhere into a
 * checkout, such as `git merge main` or `if git stash pop; then ...`. A
 * command that names git only inside single quotes, a heredoc with a quoted
 * delimiter or a comment does not; one that names it in double quotes does.
 */
export const mayImportContent = (command: string): boolean =>
  (["quote", "ignore"] as const).some((doubleQuotes) =>
    splitCommands(command, doubleQuotes).some(hasImportingCall),
  );
