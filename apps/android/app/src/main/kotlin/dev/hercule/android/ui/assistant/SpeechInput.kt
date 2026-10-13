package dev.hercule.android.ui.assistant

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext

/**
 * Turns speech into text for the hold-to-talk mic. [start] begins listening when the user
 * presses the mic, and [stop] ends it when they let go. When listening ends, the `onResult`
 * given to [start] is called once: with the recognised text, or with null when nothing was
 * recognised, recognition failed, or the app first had to ask for the microphone.
 */
interface SpeechInput {
    fun start(onResult: (text: String?) -> Unit)
    fun stop()
}

/**
 * Returns the device's on-device speech recognition as a [SpeechInput], or null when the device
 * has none. The app never sends the user's voice to a recognition service off the device, so a
 * device without on-device recognition shows no mic.
 *
 * The first press asks for the microphone permission and does not listen; once the user has
 * granted it, a press listens. A recognition that fails is reported to [onFailure] as a sentence
 * the screen shows.
 */
@Composable
fun rememberOnDeviceSpeechInput(onFailure: (String) -> Unit): SpeechInput? {
    val context = LocalContext.current
    val available = remember(context) { SpeechRecognizer.isOnDeviceRecognitionAvailable(context) }
    if (!available) return null
    val askPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    val input = remember(context) {
        OnDeviceSpeechInput(context, onFailure) { askPermission.launch(Manifest.permission.RECORD_AUDIO) }
    }
    DisposableEffect(input) { onDispose { input.destroy() } }
    return input
}

/**
 * A [SpeechInput] on the device's on-device recognizer. [askPermission] is called instead of
 * listening while the app lacks the microphone permission; failures go to [onFailure].
 */
private class OnDeviceSpeechInput(
    private val context: Context,
    private val onFailure: (String) -> Unit,
    private val askPermission: () -> Unit,
) : SpeechInput {
    private var recognizer: SpeechRecognizer? = null

    override fun start(onResult: (text: String?) -> Unit) {
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            askPermission()
            onResult(null)
            return
        }
        val listening = recognizer ?: SpeechRecognizer.createOnDeviceSpeechRecognizer(context).also { recognizer = it }
        listening.setRecognitionListener(ResultListener(onResult, onFailure))
        listening.startListening(
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM),
        )
    }

    override fun stop() {
        recognizer?.stopListening()
    }

    /** Releases the recognizer, when the screen that holds the mic leaves. */
    fun destroy() {
        recognizer?.destroy()
        recognizer = null
    }
}

/**
 * Passes the best recognised text, or null, to [onResult]. A failed recognition also passes a
 * sentence saying what went wrong to [onFailure]. Every other callback has nothing to do.
 */
private class ResultListener(
    private val onResult: (text: String?) -> Unit,
    private val onFailure: (String) -> Unit,
) : RecognitionListener {
    override fun onResults(results: Bundle) {
        onResult(results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.takeIf { it.isNotBlank() })
    }

    override fun onError(error: Int) {
        onFailure(describeRecognitionError(error))
        onResult(null)
    }

    override fun onReadyForSpeech(params: Bundle?) = Unit
    override fun onBeginningOfSpeech() = Unit
    override fun onRmsChanged(rmsdB: Float) = Unit
    override fun onBufferReceived(buffer: ByteArray?) = Unit
    override fun onEndOfSpeech() = Unit
    override fun onPartialResults(partialResults: Bundle?) = Unit
    override fun onEvent(eventType: Int, params: Bundle?) = Unit
}

/** Returns the sentence the screen shows for the recognizer's [error] code. */
private fun describeRecognitionError(error: Int): String = when (error) {
    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Nothing was heard. Hold the mic while you speak."
    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Hercule may not use the microphone. Allow it in the app's settings."
    else -> "Your words could not be recognised. Try again."
}
