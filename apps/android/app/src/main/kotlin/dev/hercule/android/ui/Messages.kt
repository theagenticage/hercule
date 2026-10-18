package dev.hercule.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hercule.android.office.OfficeFace
import dev.hercule.android.theme.BoldWeight
import dev.hercule.android.ui.markdown.MessageAuthor
import dev.hercule.android.ui.markdown.MessageMarkdown

/**
 * Draws a message sent into the session, the book's `.msg--me`: [text] as markdown by [author]
 * in a bubble on the right, as wide as its text and at most 78% of the width, with [meta] below
 * it, such as "09:02". [author] is the user, or another session's agent that sent it.
 */
@Composable
fun UserBubble(text: String, meta: String?, author: MessageAuthor, modifier: Modifier = Modifier) {
    val colors = bureauColors
    BoxWithConstraints(modifier.fillMaxWidth()) {
        Column(Modifier.align(Alignment.CenterEnd).widthIn(max = maxWidth * 0.78f), horizontalAlignment = Alignment.End) {
            Box(
                Modifier
                    .background(lerp(colors.surface, colors.ink, 0.06f), RoundedCornerShape(18.dp, 18.dp, 6.dp, 18.dp))
                    .padding(horizontal = 14.dp, vertical = 10.dp),
            ) {
                // As wide as the text's longest line, so a code block or a table inside fills the
                // bubble's width without stretching a short message's bubble to the 78%.
                MessageMarkdown(text, author, Modifier.width(IntrinsicSize.Max))
            }
            if (meta != null) {
                Text(meta, Modifier.padding(top = 4.dp), style = buildUiTextStyle(11.sp), color = colors.faint)
            }
        }
    }
}

/**
 * Draws the line above an agent's message, the book's `.m-by`: [face] at 22 dp, [name] in the
 * face's ink, and [meta] after it in the faint colour, such as "09:04".
 *
 * A long [name] is cut with an ellipsis so that [meta] always shows in full.
 */
@Composable
fun AgentByline(face: OfficeFace, name: String, meta: String?, modifier: Modifier = Modifier) {
    val colors = bureauColors
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        ColleagueFace(face, 22.dp)
        Text(
            name,
            Modifier.weight(1f, fill = false),
            style = buildUiTextStyle(13.sp, BoldWeight, lineHeight = 1.3f),
            color = pickCrewColors(face).whoInk,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (meta != null) Text(meta, style = buildUiTextStyle(12.sp, lineHeight = 1.3f), color = colors.faint, maxLines = 1)
    }
}
