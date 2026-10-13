package dev.hercule.android.ui.signin

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import dev.hercule.android.R
import dev.hercule.android.theme.DecoFontFamily
import dev.hercule.android.ui.BureauButton
import dev.hercule.android.ui.BureauTextField
import dev.hercule.android.ui.ButtonLook
import dev.hercule.android.ui.ButtonSize
import dev.hercule.android.ui.bureauColors
import dev.hercule.android.ui.buildUiTextStyle

/**
 * What the sign-in screen shows: the [controllerUrl] and [username] the form starts with, whether
 * a sign-in is [signingIn], and the [error] of the last attempt, or null when there is none.
 */
data class SignInUiState(
    val controllerUrl: String = "",
    val username: String = "",
    val signingIn: Boolean = false,
    val error: String? = null,
)

/** What the user typed into the sign-in form. */
data class SignInForm(val controllerUrl: String, val username: String, val password: String)

/**
 * Draws the sign-in screen: the mark beside the wordmark, as the desktop's centred screens draw
 * them, above a form for the controller's address, the user name and the password.
 *
 * The book has no sign-in page. The layout is the desktop's (centered-screen.css): a 320 dp
 * column whose top sits at 34% of the window's height, so the column does not move when an error
 * line appears. The status bar lies inside that 34%, so the top inset is not added to it.
 * While the keyboard is open, the form scrolls up until the Sign in button sits 24 dp above it.
 * [onSignIn] gets the form when the user presses Sign in.
 */
@Composable
fun SignInScreen(state: SignInUiState, onSignIn: (SignInForm) -> Unit, modifier: Modifier = Modifier) {
    val colors = bureauColors
    var controllerUrl by rememberSaveable { mutableStateOf(state.controllerUrl) }
    var username by rememberSaveable { mutableStateOf(state.username) }
    // The password is not saved with the screen's state, so it never reaches a saved bundle.
    var password by remember { mutableStateOf("") }
    val complete = controllerUrl.isNotBlank() && username.isNotEmpty() && password.isNotEmpty()
    val submit = { if (complete && !state.signingIn) onSignIn(SignInForm(controllerUrl.trim(), username, password)) }

    val scroll = rememberScrollState()
    // The column can scroll only when the keyboard takes away room it needs. Following the end
    // as the keyboard slides in keeps the whole form, the Sign in button too, above the keyboard,
    // where the focused field alone would otherwise be scrolled into view.
    LaunchedEffect(scroll) { snapshotFlow { scroll.maxValue }.collect { scroll.scrollTo(it) } }

    BoxWithConstraints(modifier.fillMaxSize().background(colors.bg)) {
        val top = maxHeight * 0.34f
        Column(
            Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom))
                .imePadding()
                .verticalScroll(scroll),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(top))
            // The bottom padding keeps the Sign in button clear of the keyboard's top edge.
            Column(Modifier.width(320.dp).padding(bottom = 24.dp)) {
                Lockup(Modifier.fillMaxWidth().padding(bottom = 24.dp))
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    BureauTextField(
                        controllerUrl,
                        { controllerUrl = it },
                        "Controller address",
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next, autoCorrectEnabled = false),
                    )
                    BureauTextField(
                        username,
                        { username = it },
                        "Username",
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next, autoCorrectEnabled = false),
                    )
                    BureauTextField(
                        password,
                        { password = it },
                        "Password",
                        masked = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Go),
                        keyboardActions = KeyboardActions(onGo = { submit() }),
                    )
                    if (state.error != null) {
                        Text(state.error, style = buildUiTextStyle(12.sp), color = colors.failInk)
                    }
                    BureauButton(
                        if (state.signingIn) "Signing in…" else "Sign in",
                        onClick = submit,
                        modifier = Modifier.fillMaxWidth(),
                        look = ButtonLook.Accent,
                        size = ButtonSize.Large,
                        enabled = complete,
                    )
                }
            }
        }
    }
}

/**
 * Draws the book's lockup: the mark, 40 dp, 12 dp from the wordmark "Hercule" in Limelight at
 * 32 sp, set solid. The mark has a dark-theme drawing in `drawable-night`.
 */
@Composable
private fun Lockup(modifier: Modifier = Modifier) {
    Row(
        modifier.semantics(mergeDescendants = true) { heading() },
        horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Image(painterResource(R.drawable.ic_mark), contentDescription = null, modifier = Modifier.size(40.dp))
        Text(
            "Hercule",
            style = TextStyle(
                fontFamily = DecoFontFamily,
                fontSize = 32.sp,
                lineHeight = 1.em,
                letterSpacing = 0.02.em,
                lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None),
            ),
            color = bureauColors.ink,
        )
    }
}
