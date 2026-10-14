package dev.hercule.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Draws the phone's composer, the book's `.composer-card` with its one `.m-comp` row: an attach
 * button, the text field showing [placeholder] while empty, and a round button on the right.
 *
 * The round button sends the text through [onSend] and clears the field. When the send fails,
 * [onSend]'s second argument puts the text back, unless the user has typed something new by
 * then. A send that fails after the screen was recreated, such as after a rotation, cannot put
 * it back.
 *
 * While the field is empty, [idleButton] takes the send button's place when given, such as the
 * assistant's hold-to-talk mic; otherwise the send button shows, unable to send. Attaching is not
 * part of the app yet, so the attach button is drawn disabled.
 */
@Composable
fun Composer(
    placeholder: String,
    onSend: (text: String, onFailure: () -> Unit) -> Unit,
    modifier: Modifier = Modifier,
    idleButton: (@Composable () -> Unit)? = null,
) {
    val colors = bureauColors
    var text by rememberSaveable { mutableStateOf("") }
    val shape = RoundedCornerShape(24.dp)
    val style = buildUiTextStyle(15.sp, lineHeight = 1.35f).copy(color = colors.ink)
    Row(
        modifier
            .fillMaxWidth()
            .glassShadow(shape)
            .background(colors.glassFillRaised, shape)
            .border(1.dp, colors.glassRim, shape)
            .padding(6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        IconButton(BureauIcons.Plus, "Attach", onClick = {}, enabled = false)
        BasicTextField(
            text,
            { text = it },
            Modifier.weight(1f).semantics { contentDescription = placeholder },
            textStyle = style,
            cursorBrush = SolidColor(colors.accent),
            maxLines = 5,
            decorationBox = { field ->
                Box(Modifier.heightIn(min = 40.dp).padding(horizontal = 6.dp), contentAlignment = Alignment.CenterStart) {
                    if (text.isEmpty()) Text(placeholder, style = style, color = colors.faint, maxLines = 1)
                    field()
                }
            },
        )
        if (text.isEmpty() && idleButton != null) {
            idleButton()
        } else {
            RoundButton(
                BureauIcons.Send,
                "Send",
                enabled = text.isNotBlank(),
                onClick = {
                    val sent = text.trim()
                    text = ""
                    onSend(sent) { if (text.isEmpty()) text = sent }
                },
            )
        }
    }
}

/**
 * Draws the book's round composer button, `.m-mic`: [icon] in a 44 dp circle on the button
 * fill. A button that is not [enabled] is drawn faint and does nothing.
 *
 * It still has a 48 dp touch area, because Compose extends it; see [BureauButton].
 */
@Composable
fun RoundButton(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    pressed: Boolean = false,
) {
    val colors = bureauColors
    Box(
        modifier
            .size(44.dp)
            .clip(CircleShape)
            .background(if (pressed) colors.you else colors.btnFill)
            .border(1.dp, colors.btnRim, CircleShape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        BureauIcon(icon, if (enabled) colors.ink else colors.faint, size = 20.dp)
    }
}

/**
 * Draws the book's `--glass-shadow` under a glass surface: a tight contact shadow and a wide soft
 * one, both black, at the book's glass level of 0.4.
 */
fun Modifier.glassShadow(shape: Shape): Modifier = this
    .dropShadow(shape, Shadow(radius = 2.dp, color = Color.Black, alpha = 0.056f, offset = DpOffset(0.dp, 1.dp)))
    .dropShadow(shape, Shadow(radius = 32.dp, spread = (-12).dp, color = Color.Black, alpha = 0.156f, offset = DpOffset(0.dp, 12.dp)))
