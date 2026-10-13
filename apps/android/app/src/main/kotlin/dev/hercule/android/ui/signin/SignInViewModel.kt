package dev.hercule.android.ui.signin

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.hercule.android.app.AppGraph
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
    private val mutableSignedIn = MutableStateFlow(false)

    init {
        viewModelScope.launch {
            val last = graph.readLastSignIn() ?: return@launch
            // A sign-in that already started holds what the user typed, which wins.
            mutableState.update { if (it.signingIn) it else it.copy(controllerUrl = last.controllerUrl, username = last.userName) }
        }
    }

    /** The form's state: what was typed last, whether a sign-in runs, and its error. */
    val state: StateFlow<SignInUiState> = mutableState.asStateFlow()

    /** True once [signIn] has signed the phone in, so the screen can open the Office. */
    val signedIn: StateFlow<Boolean> = mutableSignedIn.asStateFlow()

    /** Hides the last attempt's error, because the user changed the form it was about. */
    fun clearError() {
        mutableState.update { it.copy(error = null) }
    }

    /** Signs in with [form], unless a sign-in already runs. A failure is shown as the form's error. */
    fun signIn(form: SignInForm) {
        if (mutableState.value.signingIn) return
        mutableState.value = SignInUiState(form.controllerUrl, form.username, signingIn = true)
        viewModelScope.launch {
            val result = graph.signIn(form.controllerUrl, form.username, form.password)
            mutableState.update { it.copy(signingIn = false, error = describeSignInFailure(result, form.controllerUrl)) }
            if (result == SignInResult.SignedIn) mutableSignedIn.value = true
        }
    }
}

/** Returns the sentence that explains why [result] is not a sign-in, or null for [SignInResult.SignedIn]. */
fun describeSignInFailure(result: SignInResult, controllerUrl: String): String? = when (result) {
    SignInResult.SignedIn -> null
    SignInResult.BadUrl -> "Enter the controller's address, such as http://build-box-1:4937."
    SignInResult.Unreachable -> "Could not reach ${controllerUrl.trim()}. Check that the controller is running."
    SignInResult.NotStored -> "This phone could not store its API key, so it is not signed in. Try again."
    is SignInResult.Refused -> result.message.replaceFirstChar { it.uppercase() }.let { if (it.endsWith(".")) it else "$it." }
}
