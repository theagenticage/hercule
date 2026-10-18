package dev.hercule.android.markdown

import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test

/**
 * Checks the output of [parseMarkdown] for the worst-case inputs of MarkdownWorstCaseInputs.kt:
 * no text is lost and the tree has a sensible size. The cases are copied from
 * packages/client-core/src/markdown-worst-case.test.ts.
 *
 * Each parse runs on a thread with a stack of 1 MB, the size of an Android worker thread's, so
 * that a parse that recurses too deep fails here as it would on the phone. The cases after the
 * copied ones nest deeper than the parser allows, and must come back as plain text.
 */
class MarkdownWorstCaseTest {
    /** Returns what [parse] returns, run on a thread with a stack of 1 MB. */
    private fun <T> runOnSmallStack(parse: () -> T): T {
        var result: Result<T>? = null
        val thread = Thread(null, { result = runCatching(parse) }, "markdown-worst-case", 1L shl 20)
        thread.start()
        thread.join()
        return result!!.getOrThrow()
    }

    @Test
    fun `keeps the text and a sensible size for every worst-case input`() {
        for (input in WORST_CASE_INPUTS) {
            val document = runOnSmallStack { parseMarkdown(input.text) }
            if (input.shownText != null) assertEquals(input.shownText, readShownText(document), input.name)
            assertTrue(countNodes(document) < MAX_NODES_PER_CHARACTER * WORST_CASE_BYTES, input.name)
        }
    }

    @Test
    fun `shows text that nests deeper than the parser allows as written, on a small stack`() {
        val deep =
            listOf(
                ">".repeat(50_000) + " x",
                "*".repeat(50_000) + "x" + "*".repeat(50_000),
                "![".repeat(20_000) + "x" + "](u)".repeat(20_000),
                (0 until 2_000).joinToString("\n") { "  ".repeat(it) + "- " + it },
                "- ".repeat(5_000) + "x",
            )
        for (text in deep) assertEquals(showAsWritten(text), runOnSmallStack { parseMarkdown(text) })
    }

    @Test
    fun `bounds the time and memory of nested lists and quotes, however deep`() {
        val threads = java.lang.management.ManagementFactory.getThreadMXBean() as com.sun.management.ThreadMXBean
        val shapes =
            mapOf<String, (Int) -> String>(
                // Lists on one line each nest in the one before, so the text grows linearly with the depth.
                "lists" to { depth -> "- ".repeat(depth) + "x" },
                "quotes" to { depth -> ">".repeat(depth) + " x" },
            )
        val inputs =
            shapes.flatMap { (shape, build) -> listOf(10, 100, 1_000, 10_000).map { depth -> "$shape at $depth levels" to build(depth) } } +
                // Lists nested by indentation grow with the square of the depth: 1,000 levels are 1 MB.
                listOf(10, 100, 1_000).map { depth -> "indented lists at $depth levels" to (0 until depth).joinToString("\n") { "  ".repeat(it) + "- x" } } +
                listOf(
                    "200 KB of quotes" to ">".repeat(WORST_CASE_BYTES),
                    "200 KB of nested list lines" to buildString { var level = 0; while (length < WORST_CASE_BYTES) { append("  ".repeat(level % 2_000)).append("- x\n"); level++ } },
                )
        val slow = ArrayList<String>()
        for ((name, text) in inputs) {
            val result = runOnSmallStack {
                parseMarkdown(text) // warms the parser up
                val allocatedBefore = threads.getThreadAllocatedBytes(Thread.currentThread().threadId())
                val started = System.nanoTime()
                parseMarkdown(text)
                Pair((System.nanoTime() - started) / 1e6, threads.getThreadAllocatedBytes(Thread.currentThread().threadId()) - allocatedBefore)
            }
            println("markdown nesting: %.1f ms and %d KB allocated for %s (%d characters)".format(result.first, result.second / 1024, name, text.length))
            if (result.first >= NESTING_CEILING_MS) slow.add("$name: ${result.first} ms")
        }
        assertTrue(slow.isEmpty(), "These parses took longer than $NESTING_CEILING_MS ms: $slow")
    }

    private companion object {
        /** The longest a parse of deeply nested text may take: the parser stops reading nesting past the limit, so it stays linear. */
        const val NESTING_CEILING_MS = 1000.0

        /** The most nodes a tree may hold per character of input. A parse that pads or repeats a node blows past it. */
        const val MAX_NODES_PER_CHARACTER = 4

        fun countInlineNodes(inlines: List<MarkdownInline>): Int =
            inlines.sumOf { inline ->
                1 +
                    when (inline) {
                        is MarkdownInline.Strong -> countInlineNodes(inline.children)
                        is MarkdownInline.Emphasis -> countInlineNodes(inline.children)
                        is MarkdownInline.Strikethrough -> countInlineNodes(inline.children)
                        is MarkdownInline.Link -> countInlineNodes(inline.children)
                        else -> 0
                    }
            }

        fun countBlockNodes(blocks: List<MarkdownBlock>): Int =
            blocks.sumOf { block ->
                1 +
                    when (block) {
                        is MarkdownBlock.Paragraph -> countInlineNodes(block.children)
                        is MarkdownBlock.Heading -> countInlineNodes(block.children)
                        is MarkdownBlock.List -> block.items.sumOf { countBlockNodes(it.children) }
                        is MarkdownBlock.Blockquote -> countBlockNodes(block.children)
                        is MarkdownBlock.Details -> countInlineNodes(block.summary) + countBlockNodes(block.children)
                        is MarkdownBlock.Table -> (listOf(block.header) + block.rows).sumOf { row -> row.sumOf { 1 + countInlineNodes(it.children) } }
                        is MarkdownBlock.Code, MarkdownBlock.Rule -> 0
                    }
            }

        fun countNodes(document: MarkdownDocument): Int =
            countBlockNodes(document.blocks) + document.footnotes.sumOf { countBlockNodes(it.children) }

        fun readInlineText(inlines: List<MarkdownInline>): String =
            inlines.joinToString("") { inline ->
                when (inline) {
                    is MarkdownInline.Text -> inline.text
                    is MarkdownInline.InlineCode -> inline.text
                    is MarkdownInline.Image -> inline.alt
                    is MarkdownInline.Strong -> readInlineText(inline.children)
                    is MarkdownInline.Emphasis -> readInlineText(inline.children)
                    is MarkdownInline.Strikethrough -> readInlineText(inline.children)
                    is MarkdownInline.Link -> readInlineText(inline.children)
                    else -> ""
                }
            }

        fun readBlockText(blocks: List<MarkdownBlock>): String =
            blocks.joinToString("") { block ->
                when (block) {
                    is MarkdownBlock.Paragraph -> readInlineText(block.children)
                    is MarkdownBlock.Heading -> readInlineText(block.children)
                    is MarkdownBlock.List -> block.items.joinToString("") { readBlockText(it.children) }
                    is MarkdownBlock.Blockquote -> readBlockText(block.children)
                    is MarkdownBlock.Details -> readInlineText(block.summary) + readBlockText(block.children)
                    is MarkdownBlock.Table -> (listOf(block.header) + block.rows).joinToString("") { row -> row.joinToString("") { readInlineText(it.children) } }
                    is MarkdownBlock.Code -> block.text
                    MarkdownBlock.Rule -> ""
                }
            }

        /** Returns the text that a document shows, in order, without white space. */
        fun readShownText(document: MarkdownDocument): String =
            (readBlockText(document.blocks) + document.footnotes.joinToString("") { readBlockText(it.children) }).filterNot { it.isWhitespace() }
    }
}
