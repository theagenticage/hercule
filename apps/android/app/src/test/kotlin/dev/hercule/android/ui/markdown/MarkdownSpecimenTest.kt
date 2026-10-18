package dev.hercule.android.ui.markdown

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import dev.hercule.android.ui.BureauTheme
import dev.hercule.android.ui.UserBubble
import dev.hercule.android.ui.bureauColors
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Draws an agent's message holding every element the markdown tree can hold, one details block
 * opened, and under it a bubble with a list and a fenced code block, in Whitehaven and Orient
 * Express. The book draws only paragraphs, inline code and code blocks; the rest follows the
 * desktop's markdown.css at the phone's sizes (see MarkdownLook.kt).
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MarkdownSpecimenTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    @Config(qualifiers = "w390dp-h1560dp-xhdpi")
    fun drawsSpecimenInWhitehaven() = drawSpecimen(dark = false)

    @Test
    @Config(qualifiers = "w390dp-h1560dp-night-xhdpi")
    fun drawsSpecimenInOrientExpress() = drawSpecimen(dark = true)

    private fun drawSpecimen(dark: Boolean) {
        compose.setContent {
            BureauTheme(dark = dark) {
                Column(Modifier.fillMaxSize().background(bureauColors.surface).padding(16.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                    MessageMarkdown(SPECIMEN, MessageAuthor.Agent)
                    UserBubble(BUBBLE, "09:02", MessageAuthor.User)
                }
            }
        }
        compose.onNodeWithText("Open details").performClick()
        compose.onRoot().captureRoboImage()
    }
}

/** An agent's message with every element, in the order markdown.css lists them. */
private val SPECIMEN = """
    # A heading

    A paragraph with **strong**, *emphasis*, ~~struck~~ text, `inline code` and a [link](https://example.com/docs). A footnote.[^1] A hard break follows,\
    on its own line.

    ## A second heading

    - A bullet
    - A bullet with `code`
      - A nested bullet
        - A third level

    3. Starts at three
    4. Then four

    1) A loose item

    2) Another loose item

    - [x] A done task
    - [ ] An open task

    > A quote, muted, with `code` in it.

    ---

    ```ts
    const result = await confirmPayment(intent, { redirect: "if_required" });
    ```

    | Left | Centre | Right |
    |:-----|:------:|------:|
    | a | b | 1 |
    | A longer cell that wraps over several lines | `x` | 12.50 |

    <table><tr><td colspan="2">Spans two columns</td><td>1</td></tr><tr><td>a</td><td>b</td><td>c</td></tr></table>

    ![The build log](https://example.com/log.png)

    <details><summary>Shut details</summary>

    Hidden.

    </details>

    <details><summary>Open details</summary>

    Shown, indented under the summary.

    </details>

    [^1]: The footnote's text.
""".trimIndent()

/** The user's message: a line break they typed, a list, and a fenced code block. */
private val BUBBLE = """
    Two things:
    - push the branch
    - open the PR
    ```
    git push -u origin fix/3ds
    ```
""".trimIndent()
