package dev.hercule.android.ui

import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.ui.signin.SignInScreen
import dev.hercule.android.ui.signin.SignInUiState
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Draws the sign-in screen at the book's phone size, light and dark, with an error showing. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SignInScreenTest {
    private val state = SignInUiState(
        controllerUrl = "http://100.88.12.4:4937",
        username = "rogier",
        error = "The user name or password is wrong.",
    )

    @Test
    @Config(qualifiers = "w390dp-h844dp-xhdpi")
    fun drawsSignInInWhitehaven() = captureScreen(dark = false) { SignInScreen(state, onSignIn = {}) }

    @Test
    @Config(qualifiers = "w390dp-h844dp-night-xhdpi")
    fun drawsSignInInOrientExpress() = captureScreen(dark = true) { SignInScreen(state, onSignIn = {}) }
}
