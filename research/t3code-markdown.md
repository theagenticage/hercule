# Research: how t3-code renders markdown in its thread UI

Resolves the open question in rogierpennink/hydra#156 (which markdown renderer the thread surface should use). Sibling note on `research/t3code`: the earlier study of t3-code's provider integration and remote support (`research/t3code.md`, 2026-08-20).

Source: [pingdotgg/t3code](https://github.com/pingdotgg/t3code), shallow clone of `main` at `9375c779707fb95c06670db6da87441720b2d2e2` (2026-09-14). File paths below are relative to that repo. Web client is the pnpm workspace package `apps/web` (`@t3tools/web`), React 19.2.6, Vite.

## Verdict

T3 Code's web thread UI renders **assistant prose with `react-markdown` 10.1.0 + `remark-gfm` 4.0.1** (plus `remark-breaks` 4.0.0 for user messages, `rehype-raw` 7.0.0 + `rehype-sanitize` 6.0.0 with a custom schema for raw HTML, and four in-house remark/rehype plugins, incl. a GitHub-alerts plugin and a directive plugin). It does **not** use `marked`, `dompurify`, `markdown-it`, or a streaming-specialized renderer like Streamdown. During streaming it re-parses the full message text on every delivered update — there is no plain-text-then-flip mode — but two mechanisms make that cheap and stable: (1) the **server buffers assistant deltas and only delivers "safe" prefixes** (split at the last blank line / closed code fence, with a 400 ms minimum delivery interval), so partial markdown like unclosed fences rarely reaches the client; and (2) the client adds a custom **incremental markdown parser plugin** that caches the parsed AST prefix up to the last closed top-level fence and re-parses only the suffix on each frame. Syntax highlighting in code blocks is Shiki (Oniguruma WASM engine), loaded lazily per language behind React Suspense, with an LRU cache of highlighted HTML and an incremental line-preserving highlighter while streaming.

## Facts

### 1. Exact renderer packages and versions

`apps/web/package.json` lines 45–51 and 74:

```json
"react": "19.2.6",
...
"react-markdown": "^10.1.0",
"rehype-raw": "^7.0.0",
"rehype-sanitize": "^6.0.0",
"remark-breaks": "^4.0.0",
"remark-gfm": "^4.0.1",
...
"unified": "^11.0.5"
```

`pnpm-lock.yaml` pins the resolved versions (lines 9689, 9923, 9926, 9935, 9938): `react-markdown@10.1.0`, `rehype-raw@7.0.0`, `rehype-sanitize@6.0.0`, `remark-breaks@4.0.0`, `remark-gfm@4.0.1`, resolved against `react@19.2.6`.

No `marked`, `dompurify`, `markdown-it`, or `streamdown` anywhere in the web app. Syntax highlighting comes via `@pierre/diffs`' shared highlighter, Shiki with the Oniguruma WASM engine: `apps/web/src/lib/syntaxHighlighting.ts` lines 10–15 ("Always highlight with the Oniguruma WASM engine — the JS regex engine can backtrack catastrophically") and line 16 `export const PREFERRED_HIGHLIGHTER: HighlighterTypes = "shiki-wasm"`.

### 2. The rendering component

`apps/web/src/components/ChatMarkdown.tsx` (3,285 lines) is the one component both assistant and user messages render through. Imports (lines 77–89): `ReactMarkdown from "react-markdown"`, `rehypeRaw from "rehype-raw"`, `rehypeSanitize, { defaultSchema } from "rehype-sanitize"`, `remarkBreaks`, `remarkGfm`, plus in-house plugins `remarkGithubAlerts` (GitHub `[!NOTE]`-style alert callouts, `apps/web/src/markdown-github-alerts.ts`), `remarkNormalizeListItemIndentation`, `remarkCodexDirectives`, and `createIncrementalMarkdownPlugin` from `../markdown-incremental`.

Plugin arrays (lines 483–507):

```ts
const CHAT_MARKDOWN_REMARK_PLUGINS = [
  remarkGfm, remarkGithubAlerts, remarkNormalizeListItemIndentation,
  remarkCodexDirectives, remarkPreserveCodeMeta, remarkNormalizeLinksAndTagInlineCode,
];
const CHAT_MARKDOWN_REHYPE_PLUGINS = [
  rehypeRaw,
  rehypePreserveImageSourceMeta,
  [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA],
];
```

The component body (lines 3221–3284) mounts one `ReactMarkdown` with `skipHtml={false}`, a custom `urlTransform` that falls back to react-markdown's `defaultUrlTransform`, and the full `text` as children — i.e. **full re-parse per render, driven by prop changes**. The component is `export default memo(ChatMarkdown)` (line 3285), so only the message whose `text` changed re-parses.

### 3. Raw HTML and sanitization

Raw HTML **is** rendered, then sanitized. `parseRawHtml` defaults to `true` for assistant messages (line 3237), enabling `rehype-raw` + `rehype-sanitize` with a customized schema (`CHAT_MARKDOWN_SANITIZE_SCHEMA`, lines 460–481): it strips the global `title` attribute, whitelists custom `data-*` attributes it carries through its own plugins, and extends allowed `href`/`src` protocols with `file`, `t3-citation`, `t3-context`. User messages pass `parseRawHtml={false}` — rehype plugins omitted entirely, so literal HTML shows as escaped source text.

### 4. Element-to-React mapping

`CHAT_MARKDOWN_COMPONENTS` (lines ~3000–3219) provides custom components for: `a` (external links get `target="_blank" rel="noopener noreferrer"`, favicons, file links become chips with open-in-editor/reveal menus); `pre`/code blocks (wrapped in `MarkdownCodeBlock` chrome with language/file title, wrap toggle, copy button; Shiki highlight behind `Suspense` with an invisible `<pre>` fallback so "plain text never flashes before the highlighted version" — lines 3196–3206); `table` (scroll container + expand + copy-as-Markdown/CSV); `details` (collapsible); GitHub alert blockquotes (styled callouts with icons); images (reserved aspect slots, gallery expand, video player).

### 5. Streaming behaviour (the important part)

**Delivery:** the server, not the client, paces streaming. `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`:

- line 116: `const MIN_ASSISTANT_DELIVERY_INTERVAL_MS = 400;` with comment "Keeps fast models from repainting the message several times a second while still showing the first paragraph as soon as it is done."
- lines 205–238 `splitBufferedAssistantText(text)`: scans the buffer tracking open/closed fences and splits at the last boundary — "`ready` is safe to deliver now because the markdown before it will not change shape as more text arrives. `rest` stays buffered."

So the client receives only markdown-stable prefixes; an unclosed code fence stays server-side until closed (or the message completes). Introduced by commit `c07575f5` "feat(server): show finished paragraphs and code blocks while the response streams (#11062)".

**Client parse:** `thread.message-sent` events append deltas in a reducer (`packages/client-runtime/src/state/threadReducer.ts` lines 396–398: `text: message.streaming ? \`${entry.text}${message.text}\` : ...`) — no debounce between event and render (the 500 ms debounce at `threads.ts` line 308 is cache persistence, not rendering). `AssistantTimelineRow` (`apps/web/src/components/chat/MessagesTimeline.tsx` lines 1927–1955) renders `<ChatMarkdown text={messageText} isStreaming={Boolean(row.message.streaming)} ... />`, so the full markdown re-parses on every delivered update.

The optimization is `apps/web/src/markdown-incremental.ts` (107 lines). Enabled only while `isStreaming` is true and the text contains a fence (ChatMarkdown.tsx lines 3238–3241). Its header comment: "Keep the full document pipeline while avoiding parsing a completed code-heavy prefix on every token. A closed top-level fence followed by a blank line is a parsing boundary." It caches the parsed mdast children up to the boundary, re-parses only the suffix, shifts positions, and `structuredClone`s the cached prefix per render ("Remark transforms mutate their input"). It bails to a full parse on `\r`, BOM, or any document-wide definitions (link/footnote definitions). One cache instance per streaming renderer; dropped entirely when the stream finishes.

Code-block highlighting during streaming uses `createIncrementalHighlightedDocument` to keep lines individually mounted (`preserveLines`), so streaming text appends don't re-create earlier DOM lines, and the highlighted-HTML LRU cache is only written after streaming completes (ChatMarkdown.tsx lines ~1318–1370, 1050–1060: `MAX_HIGHLIGHT_CACHE_ENTRIES = 500`, 50 MB memory cap). A `data-streaming` attribute on the container "gates the fade-in for blocks that arrive while the response streams" (line 3261, CSS in `apps/web/src/index.css`).

**Partial/incomplete markdown:** handled upstream (server never delivers mid-paragraph/mid-fence text) plus react-markdown's normal CommonMark behaviour for whatever still slips through. There is no explicit client-side "close unclosed fences" repair.

### 6. User messages

User messages are also markdown-rendered, through the same `ChatMarkdown`, but with different flags: `UserMessageBody` (`MessagesTimeline.tsx` lines 3286–3309) passes `lineBreaks` (adds `remark-breaks`, so single newlines are hard breaks — "chat-style user input" per the prop doc) and `parseRawHtml={false}` (HTML escaped, no rehype-raw/sanitize). Assistant messages get raw-HTML parsing and `lineBreaks` only when the text starts with a special `★ Insight` marker (`shouldPreserveAssistantLineBreaks`, `MessagesTimeline.logic.ts` lines 172–174).

### 7. Ownership and loading

The renderer is owned entirely by the web client package `apps/web`; the shared `packages/client-runtime` contributes markdown-adjacent logic (link/image classification, directives via `micromark-extension-directive`/`remark-parse`/`unified` deps) but not the React rendering. `ChatMarkdown.tsx` is imported statically (no `React.lazy` around it); lazy loading happens one level down — Shiki is loaded per-language via a cached promise behind `<Suspense`. No `manualChunks` config was found in `apps/web/vite.config.ts`. The React Native mobile app uses a different, native renderer (`react-native-nitro-markdown`) — not relevant to a React web app, noted only for completeness.

## What this settles for Hydra (#156)

Facts first, then the reading hydra acts on:

- t3-code — the surface hydra's thread explicitly clones — chose **react-markdown + remark-gfm** and pays its bundle cost knowingly; nothing in the repo shows a size-driven attempt to swap to `marked`. The unified pipeline is load-bearing in both directions: it hosts four-plus custom remark/rehype plugins and feeds react-markdown's `components`/`urlTransform` hooks that the whole chat surface (file-link chips, code-block chrome, tables, task checkboxes) is built on. **hydra's pick of `react-markdown` 10.1.0 + `remark-gfm` 4.0.1 matches the prior art exactly, down to the versions.**
- **Raw HTML is the one structural deviation hydra keeps.** t3-code parses then sanitizes it (`rehype-raw` + `rehype-sanitize`, custom schema); hydra's ticket forbids `rehype-raw`, so raw HTML renders as literal text. That is strictly safer and simpler — one less plugin pair and no sanitize schema to maintain — and the prior art shows the upgrade path if agents ever need HTML tables rendered.
- **Streaming: hydra's plain-text tail stands, with t3-code's server pacing as the documented later lever.** t3-code never re-parses per token: the server delivers only markdown-stable prefixes (blank-line/closed-fence split, ≥400 ms), and a 107-line client plugin caches the AST prefix at closed fences. hydra's flip-on-completion (AD-4's one plain write per frame) is simpler; if the live plain tail ever reads badly, t3-code's stable-prefix delivery is pure markdown-string logic in the ingestion layer and is renderer-agnostic in spirit.
- **User messages stay plain in hydra.** t3-code markdowns them (`remark-breaks`, no raw HTML); hydra's composer is a plain textarea with ⏎-sends, and the ticket pins the bubble to `whitespace-pre-wrap`. A conscious deviation, not an oversight.

Not determinable from source: the actual gzipped bundle contribution of the markdown stack in t3-code's production build (no built bundle in the repo to measure), and whether t3-code benchmarked alternatives before choosing.
