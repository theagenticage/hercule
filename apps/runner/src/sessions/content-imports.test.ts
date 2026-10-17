import { describe, expect, it } from "vitest";
import { mayImportContent } from "./content-imports";

describe("mayImportContent", () => {
  it.each([
    ["git merge origin/main --no-edit 2>&1 | tail -10", "a merge"],
    ["cd /w; git status --short; git cherry-pick abc", "a git command after others"],
    ['/bin/zsh -lc "git -C /w checkout main -- f"', "git inside a shell's -c script"],
    ["GIT_EDITOR=true git -c core.x=y --no-pager pull", "assignments and git's options"],
    ["env -u GIT_DIR nice -n 5 sudo -u me git restore --source=main f", "wrappers with operands"],
    ["if git merge main; then :; fi", "git as an if's condition"],
    ["{ git stash pop; }", "git in a group"],
    ['echo "$(git merge main)" `git apply p.diff`', "git in command substitutions"],
    ["cat <<EOF\n$(git merge main)\nEOF", "git in an unquoted heredoc's substitution"],
    ['cat <<< "hello"\ngit merge main', "git after a here-string"],
    [
      "git switch main && git reset --hard x && git rebase --autostash y",
      "commands that move HEAD",
    ],
    ["gh pr checkout 12", "a pull request checked out"],
    ['echo "$(printf \\); git merge main)"', "git after an escaped parenthesis in a substitution"],
    ["echo `echo \\`git merge main\\``", "git in a nested, escaped backquote"],
    [
      'echo "$(case x in x) :;; esac; git merge main)"',
      "git after a case pattern in a substitution",
    ],
    ['git "mer\\\nge" main', "a subcommand split by a line continuation in double quotes"],
    ['echo "$(git -C "$repo" merge main)"', "git with quoted words inside a quoted substitution"],
    [
      "cat <<$'EOF'\nliteral\nEOF\ngit merge main",
      "git after a heredoc with an ANSI-C quoted delimiter",
    ],
    ["cat <<EOF\nnever ends\ngit merge main", "git after a heredoc whose end never comes"],
    ['echo "git merge main"', "git named inside double quotes, counted to be safe"],
    [
      "echo \"'$(git merge main)' # $(git pull)\"",
      "substitutions after quotes and # that are data",
    ],
    ["cat <<EOF\n'$(git merge main)'\n# $(git pull)\nEOF", "the same in an unquoted heredoc"],
    [
      `echo "# $(git -C 'dir with spaces' merge main)" "$(git mer'ge' x)"`,
      "a quoted operand or subcommand inside expanded text",
    ],
    ["echo $'it\\'s done'; git merge main", "git after an ANSI-C quote with an escaped apostrophe"],
  ])("recognises %j (%s)", (command) => {
    expect(mayImportContent(command)).toBe(true);
  });

  it.each([
    ["git revert HEAD", "a rollback is the session's edit"],
    ["git stash list; git log origin/main..HEAD; git stash", "git commands that write nothing"],
    ["git commit -m 'git merge later'", "git named inside a single-quoted message"],
    [
      "python3 - <<'PY'\nimport os; os.system('git merge main')\nPY",
      "git named inside a quoted heredoc",
    ],
    ["# git merge\nls", "git named inside a comment"],
    ["x=$(git merge-base HEAD main)", "a different subcommand"],
  ])("does not recognise %j (%s)", (command) => {
    expect(mayImportContent(command)).toBe(false);
  });
});
