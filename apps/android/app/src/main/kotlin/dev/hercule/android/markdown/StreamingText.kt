package dev.hercule.android.markdown

/*
 * Splits the text of a message the agent is still writing into its finished paragraphs and the
 * paragraph being written, so that only finished paragraphs are drawn as markdown. A port of
 * packages/client-core/src/threads/streaming-text.ts.
 *
 * While a message is open, its text reaches the app in two parts, the stored rows and the tail of
 * token deltas, and neither ends where a paragraph ends. Markdown drawn from such a cut closes its
 * last paragraph at the cut, so a word cut in two would show on two lines, and a code block being
 * written would show half as code and half as prose.
 */

/** The text of an open message, split at the start of its last paragraph. */
data class StreamingText(
    /** The finished paragraphs, safe to render as markdown on their own. Empty when there are none. */
    val settled: String,
    /** The paragraph being written, as plain text. */
    val open: String,
)

/**
 * Returns the marker of the code fence that [line] opens or closes: up to 3 spaces, then 3 or
 * more backticks or 3 or more tildes. Returns null when [line] is no fence.
 */
private fun findFenceMarker(line: String): String? {
    var start = 0
    while (start < 3 && start < line.length && line[start] == ' ') start++
    if (start >= line.length || (line[start] != '`' && line[start] != '~')) return null
    var end = start
    while (end < line.length && line[end] == line[start]) end++
    return if (end - start >= 3) line.substring(start, end) else null
}

/**
 * Checks whether [line] closes the fence opened with [opening]: the same character, at least as
 * many times, and nothing else on the line.
 */
private fun isClosingFence(line: String, opening: String): Boolean {
    val marker = trimJavaScriptWhitespace(line)
    return findFenceMarker(marker) == marker && marker[0] == opening[0] && marker.length >= opening.length
}

/**
 * Splits [text] after its last blank line outside a fenced code block. The part before is
 * `settled`, and the rest is `open`. A blank line inside a fence does not end a paragraph, so a
 * code block still being written stays whole in `open`.
 *
 * [from] is the `settled` part of an earlier split of the same message. While [text] starts with
 * it, the scan starts after it rather than at the start of the message. When [text] no longer
 * starts with it, as when the message's streamed text was dropped, the scan starts at the
 * beginning.
 *
 * A port of `splitStreamingText` in packages/client-core/src/threads/streaming-text.ts.
 */
fun splitStreamingText(text: String, from: String = ""): StreamingText {
    val start = if (text.startsWith(from)) from.length else 0
    var settledEnd = start
    var lineStart = start
    var fence: String? = null
    // The text after the last line break has no line break after it yet, so it is never a
    // finished blank line or a finished fence.
    while (true) {
        val lineEnd = text.indexOf('\n', lineStart)
        if (lineEnd == -1) break
        val line = text.substring(lineStart, lineEnd)
        lineStart = lineEnd + 1
        val opening = fence
        if (opening == null) {
            val marker = findFenceMarker(line)
            if (marker != null) fence = marker else if (line.all(::isJavaScriptWhitespace)) settledEnd = lineStart
        } else if (isClosingFence(line, opening)) {
            fence = null
        }
    }
    return StreamingText(settled = text.substring(0, settledEnd), open = text.substring(settledEnd))
}
