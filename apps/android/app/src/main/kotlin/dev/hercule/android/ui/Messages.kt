package dev.hercule.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hercule.android.office.OfficeFace
import dev.hercule.android.theme.BoldWeight

/** One part of a message's text: a paragraph of prose, or a fenced block of code. */
sealed interface MessagePart {
    /** A paragraph, which may hold inline code between backticks. */
    data class Paragraph(val text: String) : MessagePart

    /** A block of code that the text fenced with three backticks, without its fences. */
    data class CodeBlock(val code: String) : MessagePart
}

/**
 * Splits a message's Markdown [text] into paragraphs and fenced code blocks, in order. A blank
 * line ends a paragraph; a line that starts with three backticks opens or closes a code block,
 * and a block left open runs to the end of the text.
 *
 * This is the small part of Markdown agents write most. Headings, lists and emphasis are drawn
 * as the plain text they are written in.
 */
fun splitMessageParts(text: String): List<MessagePart> {
    val parts = mutableListOf<MessagePart>()
    val paragraph = mutableListOf<String>()
    var code: MutableList<String>? = null
    fun closeParagraph() {
        if (paragraph.isNotEmpty()) parts += MessagePart.Paragraph(paragraph.joinToString("\n"))
        paragraph.clear()
    }
    text.lines().forEach { line ->
        val fence = line.trimStart().startsWith("```")
        val open = code
        when {
            open != null && fence -> {
                parts += MessagePart.CodeBlock(open.joinToString("\n"))
                code = null
            }
            open != null -> open += line
            fence -> {
                closeParagraph()
                code = mutableListOf()
            }
            line.isBlank() -> closeParagraph()
            else -> paragraph += line
        }
    }
    code?.let { parts += MessagePart.CodeBlock(it.joinToString("\n")) }
    closeParagraph()
    return parts
}

/**
 * Draws a message's [text] as the book's `.msg-body` on the phone: 15 sp paragraphs 10 dp apart,
 * inline code on a faint ink background, and code blocks on the sunken colour, scrolling sideways
 * when a line is too long.
 */
@Composable
fun MessageBody(text: String, modifier: Modifier = Modifier) {
    val colors = bureauColors
    val parts = remember(text) { splitMessageParts(text) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        parts.forEach { part ->
            when (part) {
                is MessagePart.Paragraph -> CodeText(
                    part.text,
                    buildUiTextStyle(15.sp, lineHeight = 1.5f).copy(color = colors.ink),
                    InlineCodeStyle(12.5.sp, colors.ink, colors.ink.copy(alpha = 0.06f), padding = 5.dp, radius = 5.dp),
                )
                is MessagePart.CodeBlock -> {
                    val shape = RoundedCornerShape(12.dp)
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .background(colors.sunken, shape)
                            .border(1.dp, colors.lineSoft, shape)
                            .horizontalScroll(rememberScrollState())
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                    ) {
                        Text(part.code, style = buildMonoTextStyle(11.5.sp, lineHeight = 1.6f), color = colors.ink, softWrap = false)
                    }
                }
            }
        }
    }
}

/**
 * Draws a message the user sent, the book's `.msg--me`: [text] in a bubble on the right, at most
 * 78% of the width, with [meta] below it, such as "09:02".
 */
@Composable
fun UserBubble(text: String, meta: String?, modifier: Modifier = Modifier) {
    val colors = bureauColors
    BoxWithConstraints(modifier.fillMaxWidth()) {
        Column(Modifier.align(Alignment.CenterEnd).widthIn(max = maxWidth * 0.78f), horizontalAlignment = Alignment.End) {
            Box(
                Modifier
                    .background(lerp(colors.surface, colors.ink, 0.06f), RoundedCornerShape(18.dp, 18.dp, 6.dp, 18.dp))
                    .padding(horizontal = 14.dp, vertical = 10.dp),
            ) {
                CodeText(
                    text,
                    buildUiTextStyle(15.sp, lineHeight = 1.5f).copy(color = colors.ink),
                    InlineCodeStyle(12.5.sp, colors.ink, colors.ink.copy(alpha = 0.06f), padding = 5.dp, radius = 5.dp),
                )
            }
            if (meta != null) {
                Text(meta, Modifier.padding(top = 4.dp), style = buildUiTextStyle(11.sp), color = colors.faint)
            }
        }
    }
}

/**
 * Draws the line above an agent's message, the book's `.m-by`: [face] at 22 dp, [name] in the
 * face's ink, and [meta] after it in the faint colour, such as "Opus · 09:04".
 */
@Composable
fun AgentByline(face: OfficeFace, name: String, meta: String?, modifier: Modifier = Modifier) {
    val colors = bureauColors
    val whoInk = pickCrewColors(face).whoInk
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        ColleagueFace(face, 22.dp)
        Text(
            buildAnnotatedString {
                withStyle(SpanStyle(color = whoInk, fontWeight = BoldWeight, fontSize = 13.sp)) { append(name) }
                if (meta != null) append("  $meta")
            },
            style = buildUiTextStyle(12.sp, lineHeight = 1.3f),
            color = colors.faint,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
