package dev.hercule.android.markdown

import java.lang.management.ManagementFactory
import kotlin.test.assertTrue
import org.junit.Test

/**
 * Times [parseMarkdown] on the worst-case inputs of MarkdownWorstCaseInputs.kt and on a long
 * message of ordinary markdown, and fails when one takes more than [CEILING_MS]. A port of
 * packages/client-core/src/markdown.speed.test.ts.
 *
 * What it guards is an order of magnitude, as in client-core: a parse that takes linear time
 * takes milliseconds on these 200 KB inputs (at most about 55 ms), and one that grows faster than
 * linear takes seconds. The ceiling sits far above the first and far below the second. Unlike
 * client-core's, it runs in every test run, so it measures the CPU time of the thread that
 * parses, not the time on the clock, which a busy machine stretches. The JVM warms up on the
 * first runs, and the fastest of [RUNS] counts. Each input's time is printed.
 */
class MarkdownSpeedTest {
    /** Returns the least CPU time, in milliseconds, that this thread spent on one of [RUNS] parses of [text]. */
    private fun timeFastest(text: String): Double {
        val threads = ManagementFactory.getThreadMXBean()
        var fastest = Double.MAX_VALUE
        repeat(RUNS) {
            val started = threads.currentThreadCpuTime
            parseMarkdown(text)
            fastest = minOf(fastest, (threads.currentThreadCpuTime - started) / 1e6)
        }
        return fastest
    }

    @Test
    fun `parses every worst-case input in under the ceiling`() {
        val slow = ArrayList<String>()
        for (input in WORST_CASE_INPUTS) {
            val fastest = timeFastest(input.text)
            println("markdown speed: %.1f ms of CPU time for %s".format(fastest, input.name))
            if (fastest >= CEILING_MS) slow.add("${input.name}: $fastest ms")
        }
        assertTrue(slow.isEmpty(), "These parses took more than $CEILING_MS ms of CPU time: $slow")
    }

    @Test
    fun `parses a 20 KB message of ordinary markdown in under the ceiling`() {
        val section =
            """
            ## Section

            Some **bold** text, some *emphasis*, `inline code`, a [link](https://example.com/a?b=1) and
            https://example.com/bare plus a footnote[^1].

            - an item with <b>HTML</b>
            - [x] a task
              1. nested

            > a quote with a line
            > that goes on

            | a | b |
            |---|:-:|
            | 1 | **2** |

            ```kotlin
            val x = 1
            ```

            """.trimIndent()
        val message = section.repeat(20_000 / section.length + 1) + "\n\n[^1]: The note."
        val fastest = timeFastest(message)
        println("markdown speed: %.1f ms of CPU time for a %d KB message".format(fastest, message.length / 1000))
        assertTrue(fastest < CEILING_MS, "The message took $fastest ms of CPU time")
    }

    private companion object {
        /** The most CPU time a parse may take, in milliseconds: well above a linear parse, well below a quadratic one. */
        const val CEILING_MS = 1000.0

        /** How often each input is parsed. The fastest run counts. */
        const val RUNS = 5
    }
}
