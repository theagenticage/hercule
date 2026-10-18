package dev.hercule.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.addOutline
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.offset
import androidx.compose.ui.unit.sp
import dev.hercule.android.markdown.DocumentCache
import dev.hercule.android.markdown.DocumentKey
import dev.hercule.android.office.OfficeFace
import dev.hercule.android.theme.BoldWeight
import dev.hercule.android.threads.MessageSender
import dev.hercule.android.threads.SenderLink
import dev.hercule.android.threads.SenderReading
import dev.hercule.android.ui.markdown.MessageAuthor
import dev.hercule.android.ui.markdown.MessageMarkdown
import dev.hercule.android.ui.markdown.ParsedMessage

/**
 * Draws a message sent into the session, the book's `.msg--me`: [text] as markdown by [author]
 * in a bubble on the right, as wide as its text and at most 78% of the width, with [meta] below
 * it, such as "09:02". [author] is the user, or another session's agent that sent it. [parsed]
 * is the text's parsed markdown when the screen has it ready; otherwise the bubble parses the
 * text and stores it in [cache] under [cacheKey], when given (see MessageMarkdown).
 *
 * [sender] adds another agent's chip and tint, or reserves the chip's height while the sender
 * is unread. The chip opens [onOpenSender] when the sender has a link. Its width never changes
 * the bubble's width. [author] alone decides how the markdown is read.
 */
@Composable
fun UserBubble(
    text: String,
    meta: String?,
    author: MessageAuthor,
    modifier: Modifier = Modifier,
    parsed: ParsedMessage? = null,
    cache: DocumentCache? = null,
    cacheKey: DocumentKey? = null,
    sender: MessageSender = MessageSender.Owner,
    onOpenSender: (SenderLink) -> Unit = {},
) {
    val colors = bureauColors
    val reading = (sender as? MessageSender.Agent)?.reading
    val neutral = lerp(colors.surface, colors.ink, 0.06f)
    val tint = reading?.let { pickCrewColors(it.face).whoTint }
    val fill = if (tint == null) neutral else if (LocalDarkTheme.current) lerp(neutral, tint, 0.7f) else tint
    val bubbleTouch = if (reading == null || reading.link == SenderLink.None) Modifier else Modifier.clipToBounds().pointerInput(Unit) {
        // Give the bubble's padding its own hit area, so the chip's expanded touch area cannot
        // take a tap inside the bubble. The markdown still handles its links and selection.
        awaitEachGesture {
            awaitFirstDown(requireUnconsumed = false)
            waitForUpOrCancellation()
        }
    }
    val semantics = if (reading == null) Modifier else Modifier.semantics {
        contentDescription = "Message from ${reading.label}"
        isTraversalGroup = true
    }
    BoxWithConstraints(modifier.fillMaxWidth().then(semantics)) {
        val bubbleWidth = maxWidth * 0.78f
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
            if (sender != MessageSender.Owner) {
                SenderChip(reading, onOpenSender)
                Spacer(Modifier.height(4.dp))
            }
            Column(Modifier.widthIn(max = bubbleWidth), horizontalAlignment = Alignment.End) {
                Box(
                    Modifier
                        .then(bubbleTouch)
                        .background(fill, RoundedCornerShape(18.dp, 18.dp, 6.dp, 18.dp))
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                ) {
                    // As wide as the text's longest line, so a code block or a table inside fills the
                    // bubble's width without stretching a short message's bubble to the 78%.
                    MessageMarkdown(text, author, Modifier.width(IntrinsicSize.Max), parsed = parsed, cache = cache, cacheKey = cacheKey)
                }
                if (meta != null) {
                    Text(meta, Modifier.padding(top = 4.dp), style = buildUiTextStyle(11.sp), color = colors.faint)
                }
            }
        }
    }
}

/** Draws [sender]'s idle face and name or, when [sender] is null, holds their height. */
@Composable
private fun SenderChip(sender: SenderReading?, onOpenSender: (SenderLink) -> Unit) {
    val height = with(LocalDensity.current) { maxOf(18.dp, 18.sp.toDp()) }
    if (sender == null) {
        Spacer(Modifier.height(height))
        return
    }
    val link = sender.link
    val interactions = remember { MutableInteractionSource() }
    val pressed by interactions.collectIsPressedAsState()
    val action = if (link == SenderLink.None) Modifier else Modifier
        // The pressed background has room around the face and name, without moving either or
        // changing the height reserved while the sender is unread.
        .layout { measurable, constraints ->
            val horizontal = 10.dp.roundToPx()
            val vertical = 4.dp.roundToPx()
            val placeable = measurable.measure(constraints.offset(horizontal = horizontal, vertical = vertical))
            layout(placeable.width - horizontal, placeable.height - vertical) {
                placeable.placeRelative(-4.dp.roundToPx(), -2.dp.roundToPx())
            }
        }
        // Clip the drawing alone: clipping the layer also cuts off its expanded touch area.
        .drawWithCache {
            val outline = RoundedCornerShape(9.dp).createOutline(size, layoutDirection, this)
            val path = Path().apply { addOutline(outline) }
            onDrawWithContent { clipPath(path) { this@onDrawWithContent.drawContent() } }
        }
        .background(if (pressed) bureauColors.hover else Color.Transparent)
        .clickable(interactionSource = interactions, onClickLabel = "Open ${sender.name}") { onOpenSender(link) }
        .padding(start = 4.dp, end = 6.dp, top = 2.dp, bottom = 2.dp)
    Row(
        Modifier.widthIn(max = 240.dp).height(height).then(action),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ColleagueFace(sender.face, 18.dp)
        Text(
            sender.name,
            Modifier.weight(1f, fill = false),
            style = buildUiTextStyle(13.sp, BoldWeight, lineHeight = 18f / 13f),
            color = pickCrewColors(sender.face).whoInk,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
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
