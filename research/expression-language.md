# Research: TypeScript-native expression language for workflow conditions

Ticket: https://github.com/rogierpennink/hydra/issues/27
Date checked: 2026-08-21. All download/star/date figures are from that day.

## TL;DR

Keep CEL. Use `@marcbachmann/cel-js` as the evaluator: pure JS, zero dependencies, actively maintained, covers the CEL constructs Hydra needs (all operators, `has`, `all`, `exists`, `map`, `filter`, custom functions, a type-check API for pre-flight validation, and parse-time structural limits). Keep `@bufbuild/cel` (cel-es, by Buf) as the named fallback: it is company-backed and tests against the official cel-spec conformance data, but is self-declared beta with a narrower API. Because both implement the same spec, Hydra should hide the evaluator behind a small internal interface so the implementation can be swapped without touching workflow definitions. The main alternatives fail a hard requirement or the familiarity bar: JSONata allows recursive user-defined functions so termination is not guaranteed by the language; JMESPath's original JS package is stale and the community fork has minimal adoption; expr (Go) has no TS port; jexl is unmaintained; FEEL (feelin) is credible but niche.

## Requirements recap

One embedded, non-Turing-complete expression language for four sites: step skip-conditions, edge conditions (incl. cycle-closing), start-trigger event filters, signal-trigger correlation keys. Must: evaluate in pure TS/JS (no wasm/native), guarantee termination, be sandboxed (no host access), evaluate against JSON contexts (`inputs`, `steps.<id>.output`, `event`), and be friendly to humans in a web UI and to LLM agents generating expressions.

Note on the four sites: three are boolean predicates; correlation keys are value-producing expressions (extract a string/number from `event` or step output). Any candidate must do both. All CEL/JSONata/JMESPath candidates do.

## Candidates

### CEL (the language)

- Spec: [github.com/google/cel-spec](https://github.com/google/cel-spec) (3.9k stars, active). [cel.dev](https://cel.dev/) states CEL is "Non-Turing complete, and only accesses data provided by the host application" and "designed to evaluate safely and quickly (nanoseconds to microseconds) with predictable costs".
- Termination is a language property, not an implementation option: no user-defined functions, no recursion; comprehension macros (`all`/`exists`/`map`/`filter`) are bounded by the size of the input data ([langdef, macros](https://github.com/google/cel-spec/blob/master/doc/langdef.md#macros)).
- Familiarity: CEL is the condition language of Kubernetes (admission policies, CRD validation), Google Cloud IAM conditions, and Envoy. Heavily present in docs and LLM training data. C-family syntax (`&&`, `==`, ternary) that reads naturally to humans.

### `@marcbachmann/cel-js` - recommended

- npm: v8.0.0, first published 2025-06, last publish 2026-07-07, ~376k weekly downloads, MIT, zero runtime dependencies (npm registry, checked 2026-08-21).
- Repo: [marcbachmann/cel-js](https://github.com/marcbachmann/cel-js), 186 stars, last push 2026-08-16, steady commit activity (Renovate-driven plus real fixes, e.g. SES-bundling fix, regex-backtracking hardening in 2026).
- Feature coverage ([README](https://github.com/marcbachmann/cel-js#readme)): "Most of the CEL Spec - including macros, custom functions and types, optional chaining, input variables, and all operators". Macros `has`, `all`, `exists`, `exists_one`, `map` (2- and 3-arg), `filter`, `cel.bind`; string/timestamp/duration methods; raw/triple-quoted/byte strings.
- Safety knobs: parse-time structural limits (`maxAstNodes`, `maxDepth`, `maxListElements`, `maxMapEntries`, `maxCallArguments`); an `Environment` API with declared variables and type checking (`env.check(expr)`) so expressions can be validated at workflow-save time, before any run; `getDefinitions()` exposes registered variables/functions, useful for autocomplete in a web UI and for prompting agents.
- Evaluation is a tree-walk over its own AST; context values are plain JS data. No `eval`, no codegen (it can run under SES lockdown per the 2026 commit).
- Extensive test suite (36 test files covering operators, macros, type-checker, limits), but no claim of running the official cel-spec conformance suite.
- Caveat: CEL ints are `BigInt`. The README states: pass integer context values as `BigInt`, or set `unlistedVariablesAreDyn: true` to accept plain numbers via coercion. Hydra feeds JSON, so it must either declare context variables as `dyn`/schema types or normalize numbers; this needs a deliberate policy (see Risks).
- Bus factor: effectively one maintainer.

### `cel-js` (ChromeGG) - ruled out

- npm: v0.8.2, last publish 2025-07-11, ~153k weekly downloads, MIT, depends on chevrotain + ramda.
- Repo [ChromeGG/cel-js](https://github.com/ChromeGG/cel-js) is **archived** (as of 2026-04). Its README says the maintainer has no time and explicitly points to marcbachmann/cel-js as "a great implementation ... full syntax support and better performance". Its own feature list was incomplete (no raw/triple-quote/byte strings, no bytes). Dead end.

### `@bufbuild/cel` (cel-es) - fallback

- npm: v0.6.0, last publish 2026-06-01, ~335k weekly downloads, Apache-2.0. Deps: `@bufbuild/cel-spec` (official CEL definitions and test data repackaged) and `@bufbuild/re2` (RE2-compatible regex engine, a TypeScript fork of RE2JS - pure TS, not wasm; boolean matching only, and linear-time so regex DoS-safe).
- Repo: [bufbuild/cel-es](https://github.com/bufbuild/cel-es), 35 stars, last push 2026-08-12, backed by Buf (they need it for protovalidate-es). README declares **"Status: Beta"**.
- Strengths: corporate backing, tests against official cel-spec conformance data, protobuf-native. Weaknesses: beta, low-level API (no environment/type-check ergonomics comparable to marcbachmann), fewer extension points, protobuf-shaped worldview that Hydra's plain-JSON contexts do not need.

### JSONata - ruled out (termination)

- npm: v2.2.2, last publish 2026-07-16, ~1.38M weekly downloads, MIT, zero deps. Repo [jsonata-js/jsonata](https://github.com/jsonata-js/jsonata), 2.7k stars, active (IBM-originated).
- Expressive transformation language, great for reshaping JSON. But [its docs](https://docs.jsonata.org/programming) show user-defined lambdas, higher-order functions, and explicit support for recursion ("Functions that have been assigned to variables can invoke themselves... This allows recursive functions to be defined"). So termination is **not** a language guarantee; hosts must bolt on timeouts/depth limits (AWS runs JSONata under a 1s evaluation timeout and a max recursion depth in Step Functions: [AWS docs](https://docs.aws.amazon.com/step-functions/latest/dg/transforming-data.html)).
- AWS Step Functions adopted JSONata for state I/O transformation in Nov 2024 ([announcement](https://aws.amazon.com/about-aws/whats-new/2024/11/aws-step-functions-variables-jsonata-transformations/)), which boosts familiarity - but AWS uses it as a transformation language with sandbox-side kill switches, not as a guaranteed-terminating condition language. If Hydra later needs a data-mapping/transformation language between steps (a different problem than conditions), JSONata is the natural candidate there.

### JMESPath - ruled out (staleness / expressiveness)

- Original `jmespath` npm: v0.16.0, last publish 2022-01, repo [jmespath/jmespath.js](https://github.com/jmespath/jmespath.js) last pushed 2023-12, license metadata unresolved (NOASSERTION on GitHub). Effectively unmaintained despite 8.4M weekly downloads (AWS SDK legacy).
- Community fork `@jmespath-community/jmespath`: MPL-2.0, v1.3.0 (2025-07), active repo but 12 stars and ~68k weekly downloads - minimal adoption.
- The original spec lacks arithmetic and general boolean expressions outside filters; the community spec extends it, but then you are on a niche dialect. Weak fit for conditions; it is a query language, not a predicate language.

### expr (expr-lang, Go) - ruled out (no TS runtime)

- The Go library Argo Workflows uses. No TS port exists; the project [discusses](https://github.com/expr-lang/expr/discussions/451) a future expr.js and suggests wasm in the meantime. Fails the pure-TS requirement.

### Others, briefly

- `jexl` (TomFrost): last npm publish 2020, repo quiet since 2023. Unmaintained; supports arbitrary async transforms (sandboxing burden on the host). Ruled out.
- `filtrex`: v3.1.0 (2024-10), ~485k weekly downloads, compiles to a JS function. Niche language, single-maintainer, no spec, low LLM familiarity. Ruled out.
- `feelin` (DMN FEEL by nikku, used by bpmn-io/Camunda form-js): v7.0.1 (2026-05), active, MIT. Credible standard (DMN FEEL is built for decision conditions), but small ecosystem (61 stars, ~25k weekly downloads), 4 runtime deps, FEEL syntax (`and`/`or`, `[1..10]`) is less familiar to web developers and LLMs than C-style CEL. Ruled out on familiarity and ecosystem, not on soundness.

## Comparison

| | @marcbachmann/cel-js | @bufbuild/cel | cel-js (ChromeGG) | jsonata | jmespath (orig / community) | feelin |
|---|---|---|---|---|---|---|
| Language | CEL | CEL | CEL (subset) | JSONata | JMESPath | DMN FEEL |
| Pure TS/JS, no wasm | yes, zero deps | yes | yes | yes | yes | yes |
| Guaranteed termination | yes (CEL property) | yes (CEL property) | yes | **no** (recursion) | yes | yes |
| Sandboxed by design | yes | yes | yes | yes (but needs timeboxing) | yes | yes |
| Maintained (2026-08) | yes | yes (beta) | **archived** | yes | no / barely | yes |
| Weekly downloads | 376k | 335k | 153k | 1.38M | 8.4M / 68k | 25k |
| Pre-flight type check | yes (`env.check`) | limited | no | no | no | limited |
| Human + LLM familiarity | high (K8s, GCloud) | high | high | medium-high | medium | low |
| License | MIT | Apache-2.0 | MIT | MIT | Apache-2.0 / MPL-2.0 | MIT |

## Recommendation

Adopt CEL as Hydra's single expression language, evaluated with `@marcbachmann/cel-js`, wrapped in a small Hydra-owned module (parse, check, evaluate; nothing else leaks out).

Fit to the four sites:

1. **Step skip-conditions / 2. edge conditions**: boolean CEL over `inputs`, `steps.<id>.output`. `steps.build.output.status == "green" && inputs.retries < 3` reads well in a UI and is trivially generated by agents. Cycle-closing conditions are just edge conditions; CEL's guaranteed termination means a condition evaluation can never hang a scheduler tick.
2. **Start-trigger event filters**: `has(event.payload.customer) && event.type == "order.created"`. `has()` is exactly the presence-test these filters need on loosely-shaped events.
3. **Signal-trigger correlation keys**: CEL is value-producing, so `event.payload.orderId` or `string(event.payload.orderId)` works as-is; the environment's `check()` can enforce at save-time that the expression returns a string.

Operational plan:

- Declare `inputs`, `steps`, `event` as environment variables (schema or `dyn`), validate every stored expression with `env.check()` at workflow-definition save time, and reject anything that fails to parse or type-check.
- Set the parse-time limits (`maxAstNodes`, `maxDepth`, ...) to modest values; conditions should be small.
- Decide the number policy up front: either normalize JSON numbers when building the context or run with `unlistedVariablesAreDyn`/dyn-typed variables so `event.count > 3` works on plain JSON without BigInt friction. Recommend dyn-typed context variables for v1; revisit typed schemas later.
- Do not register async or side-effecting custom functions; keep the function whitelist pure.

## Risks and mitigations

1. **Single-maintainer risk (marcbachmann/cel-js).** The strongest TS CEL implementation is one person's project; the previous community favorite (ChromeGG/cel-js) was archived within ~2.5 years. Mitigation: CEL is a spec with multiple implementations; keep the evaluator behind Hydra's own interface, pin versions, and treat `@bufbuild/cel` (company-backed, conformance-tested) as the tested migration path. Workflow definitions store CEL source, not library artifacts, so a swap is invisible to users.
2. **Spec-coverage gaps.** "Most of the CEL spec" is not a conformance certificate; subtle divergences (int/uint edge cases, string formatting) may differ from cel-go. Mitigation: Hydra only needs a small subset; add a Hydra-side test corpus of representative expressions (and, if desired, run selected official conformance cases from `@bufbuild/cel-spec` against the wrapper in CI).
3. **Evaluation cost is bounded but not metered.** CEL terminates, but `bigList.all(x, bigList.exists(y, ...))` is O(n^2); neither TS implementation has cel-go-style runtime cost accounting. Mitigation: parse-time AST/depth limits plus caps on context size (event payloads, step outputs are already bounded by Hydra's own payload limits); optionally wall-clock-guard evaluation as a belt-and-braces measure.
4. **BigInt/JSON impedance.** CEL int semantics vs JSON doubles can surprise expression authors (`1 == 1.0` nuances, BigInt context values). Mitigation: the dyn-context policy above, documented once; save-time `check()` catches most type mistakes.
5. **Beta fallback.** If cel-js dies and cel-es is still beta at swap time, API churn is possible. Mitigation: the wrapper interface again; also cel-es's surface Hydra needs (parse + eval against a map) is the stable core of that project since it underpins protovalidate-es.

## Sources

- CEL spec and site: https://github.com/google/cel-spec , https://cel.dev/ , https://github.com/google/cel-spec/blob/master/doc/langdef.md#macros
- marcbachmann/cel-js: https://github.com/marcbachmann/cel-js , npm registry metadata for `@marcbachmann/cel-js`
- ChromeGG/cel-js (archived): https://github.com/ChromeGG/cel-js , npm registry metadata for `cel-js`
- Buf cel-es: https://github.com/bufbuild/cel-es , npm registry metadata for `@bufbuild/cel`, `@bufbuild/re2`
- JSONata: https://github.com/jsonata-js/jsonata , https://docs.jsonata.org/programming , https://docs.aws.amazon.com/step-functions/latest/dg/transforming-data.html , https://aws.amazon.com/about-aws/whats-new/2024/11/aws-step-functions-variables-jsonata-transformations/
- JMESPath: https://github.com/jmespath/jmespath.js , https://github.com/jmespath-community/typescript-jmespath , npm registry metadata
- expr: https://github.com/expr-lang/expr , https://github.com/expr-lang/expr/discussions/451
- Others: https://github.com/TomFrost/Jexl , https://github.com/cshaa/filtrex , https://github.com/nikku/feelin , npm registry metadata (all figures checked 2026-08-21)
