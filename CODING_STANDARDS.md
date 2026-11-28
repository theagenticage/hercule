# Coding standards

These rules apply when you write code and when you review it.

## Names carry their own context

1. A type or a field is named for what it stands for, in the project's vocabulary (a GLOSSARY.md word where one exists; GLOSSARY.md holds the application's concepts, not every module's details), qualified when look-alikes exist. Never for how it is encoded or transported, or for which caller uses it.
2. A function is named for what it does and to what: verb plus object (`excludeSecretFields(schema)`), or for a pure query, the question it answers about its argument (`requiresApproval(mode, toolName)`). The verb tells the truth about the work: `get` reads something that already exists, `compute`, `build` and `parse` produce something, and a boolean query reads as its question. `getHash` is wrong for a function that computes one. A name with no verb, or no subject, is not a name yet. The `<thing>Of(x)` shape (`resultOf`, `specOf`, `recordOf`) has no verb and is not a name: say what is done (`readSpec`, `buildRecord`, `decideResult`). The one exception is a method on a service or repository whose name already supplies the subject: `agents.list(request)` and `agents.delete(id)` read as verb plus object at the call site, and the method name alone is enough.
3. A name is read without the file, the folder or the call site. Bare nouns, bare adjectives or gerunds, and nicknames a comment invented fail this. `one`, `said`, `deepest`, `ends`, `normalizing` are not function names.
4. One concept has one spelling in every package it crosses. The owner of a shared contract names it once; callers import that name and never alias it.
5. A name stays true when the mechanism behind it changes.
6. The product name never appears inside an identifier. `endedBySystem`, not `endedByHercule`: the product can be renamed, and the code should not care.

## Comments are written for a newcomer

The reader knows TypeScript but not this codebase. Write comments, docstrings and user-facing messages in plain, natural English, the way you would explain the code to a colleague.

1. A function's docstring starts with a verb that says what the function does: "Parses...", "Returns...", "Checks that...". It says what the function returns and when it fails. A reader who sees only the signature and the docstring can use the function without reading its body.
2. After that, say why, if the reason is not obvious. Inline comments only explain why, and never repeat what a line does.
3. Use the ordinary words of programming: returns, parses, validates, converts, fails, error, schema. Use GLOSSARY.md words for domain concepts. Never invent a phrase to avoid a common word.
4. Things do not talk. Text does not "say" and a list does not "answer". Write what actually happens: "the YAML parses to", "the list is sorted by".
5. Use short sentences and active voice. If there are three or more rules or cases, write a bullet list, not one long sentence.
6. Each "it", "this" and "that" must be obvious. If the reader has to look back to find what it refers to, name the thing.
7. Read the comment aloud. If you have to read a sentence twice, or no person would say it that way, rewrite it.

A comment stands alone: a reader one year from now, human or agent, must understand it without the spec, the plan, the ticket or the review round that produced it. Never write "D-21:" or "per F-3" as the explanation. Citing a spec section is fine in addition to the explanation, never instead of it. A message that refuses a request says what was wrong, why, and what the caller should do instead.
