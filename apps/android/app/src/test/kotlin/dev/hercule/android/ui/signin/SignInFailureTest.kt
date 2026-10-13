package dev.hercule.android.ui.signin

import dev.hercule.android.app.SignInResult
import kotlin.test.assertEquals
import kotlin.test.assertNull
import org.junit.Test

/** Tests [describeSignInFailure], the error line under the sign-in form. */
class SignInFailureTest {
    @Test
    fun `has no error for a sign-in`() {
        assertNull(describeSignInFailure(SignInResult.SignedIn, "http://build-box-1:4937"))
    }

    @Test
    fun `asks for an address with an example`() {
        assertEquals("Enter the controller's address, such as http://build-box-1:4937.", describeSignInFailure(SignInResult.BadUrl, "ftp://x"))
    }

    @Test
    fun `names the address nothing answered at`() {
        assertEquals(
            "Could not reach http://build-box-1:4937. Check that the controller is running.",
            describeSignInFailure(SignInResult.Unreachable, "http://build-box-1:4937"),
        )
    }

    @Test
    fun `shows the controller's refusal as a sentence`() {
        assertEquals(
            "The username or password is incorrect.",
            describeSignInFailure(SignInResult.Refused("the username or password is incorrect"), "http://build-box-1:4937"),
        )
        assertEquals("Already a sentence.", describeSignInFailure(SignInResult.Refused("Already a sentence."), "x"))
    }
}
