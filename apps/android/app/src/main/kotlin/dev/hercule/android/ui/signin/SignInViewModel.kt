package dev.hercule.android.ui.signin

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.hercule.android.app.AppGraph
import dev.hercule.android.app.SignInAttempt
import dev.hercule.android.app.SignInResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Holds the sign-in form's state and signs in. The form starts with the controller address and
 * user name of the last sign-in, so signing in again after a sign-out takes only the password.
 */
class SignInViewModel(private val graph: AppGraph) : ViewModel() {
    private val mutableState = MutableStateFlow(SignInUiState())
    private val mutableSucceededSignIn = MutableStateFlow<SignInAttempt?>(null)

    /** The sign-in this screen shows, until the user has seen how it ended. */
    private var shownSignIn: SignInAttempt? = null

    init {
        // A sign-in an earlier screen started can still run, or have failed unseen, after that
        // screen closed. This screen shows it, so the user neither signs in twice nor misses
        // the failure.
        val unseen = graph.findUnseenSignIn()
        if (unseen != null) {
            follow(unseen)
        } else {
            viewModelScope.launch {
                val last = graph.readLastSignIn() ?: return@launch
                // A sign-in that already started holds what the user typed, which wins.
                mutableState.update { if (it.signingIn) it else it.copy(controllerUrl = last.controllerUrl, username = last.userName) }
            }
        }
    }

    /** The form's state: what was typed last, whether a sign-in runs, and its error. */
    val state: StateFlow<SignInUiState> = mutableState.asStateFlow()

    /**
     * The last sign-in this screen showed that signed the phone in, or null when none did, so the
     * screen can open the Office. It holds the sign-in rather than a flag, so that each success
     * is a new value: after a refused key keeps the screen on sign-in, a retry opens the Office.
     */
    val succeededSignIn: StateFlow<SignInAttempt?> = mutableSucceededSignIn.asStateFlow()

    /** Hides the last attempt's error, because the user changed the form it was about. */
    fun clearError() {
        mutableState.update { it.copy(error = null) }
        shownSignIn?.takeIf { it.result.isCompleted }?.let(graph::markSignInSeen)
    }

    /** Signs in with [form], unless a sign-in already runs. A failure is shown as the form's error. */
    fun signIn(form: SignInForm) {
        if (mutableState.value.signingIn) return
        follow(graph.startSignIn(form.controllerUrl, form.username, form.password))
    }

    /**
     * Shows [signIn] as running, then its result: an error on the form, or [succeededSignIn]. An error
     * counts as seen once the user edits the form it is about.
     */
    private fun follow(signIn: SignInAttempt) {
        shownSignIn = signIn
        mutableState.value = SignInUiState(signIn.controllerUrl, signIn.userName, signingIn = true)
        viewModelScope.launch {
            val result = signIn.result.await()
            mutableState.update { it.copy(signingIn = false, error = describeSignInFailure(result, signIn.controllerUrl)) }
            if (result == SignInResult.SignedIn) mutableSucceededSignIn.value = signIn
        }
    }
}

/** Returns the sentence that explains why [result] is not a sign-in, or null for [SignInResult.SignedIn]. */
fun describeSignInFailure(result: SignInResult, controllerUrl: String): String? = when (result) {
    SignInResult.SignedIn -> null
    SignInResult.BadUrl -> "Enter the controller's address, such as http://build-box-1:4937."
    SignInResult.Unreachable -> "Could not reach ${controllerUrl.trim()}. Check that the controller is running."
    SignInResult.NotStored -> "This phone could not store its API key, so it is not signed in. Try again."
    is SignInResult.NotStoredNorRevoked ->
        "This phone could not store its API key, so it is not signed in, and the controller did not revoke the key: " +
            "${result.revokeFailure}. Revoke \"${result.apiKeyName}\" in the web app's settings, then try again."
    is SignInResult.Refused -> result.message.replaceFirstChar { it.uppercase() }.let { if (it.endsWith(".")) it else "$it." }
}
