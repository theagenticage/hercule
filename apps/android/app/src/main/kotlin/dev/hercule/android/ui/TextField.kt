package dev.hercule.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Draws a one-line text field as the book's `.field`: [value] on the field colour with a soft
 * edge, and [placeholder] in the faint colour while it is empty. A [masked] field draws dots
 * instead of the text, for a password or a secret answer.
 *
 * The book's field is 34 px tall for a pointer; on the phone it is 44 dp, a thumb's height, with
 * 15 sp text as the book's other phone inputs use.
 */
@Composable
fun BureauTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    masked: Boolean = false,
    enabled: Boolean = true,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
) {
    val colors = bureauColors
    val shape = RoundedCornerShape(12.dp)
    val style = buildUiTextStyle(15.sp, lineHeight = 1.2f).copy(color = colors.ink)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.semantics { contentDescription = placeholder },
        enabled = enabled,
        singleLine = true,
        textStyle = style,
        cursorBrush = SolidColor(colors.accent),
        visualTransformation = if (masked) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = keyboardOptions,
        keyboardActions = keyboardActions,
        decorationBox = { field ->
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(44.dp)
                    .background(colors.field, shape)
                    .border(1.dp, colors.lineSoft, shape)
                    .padding(horizontal = 12.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                if (value.isEmpty()) Text(placeholder, style = style, color = colors.faint, maxLines = 1)
                field()
            }
        },
    )
}
