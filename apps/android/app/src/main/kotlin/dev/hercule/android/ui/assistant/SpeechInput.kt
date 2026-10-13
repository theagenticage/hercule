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
 * presses the mic, and [stop] ends it when they let go; the recognised text then reaches the
 * `onText` given to [start], once, and nothing reaches it when nothing was recognised.
 */
interface SpeechInput {
    fun start(onText: (String) -> Unit)
    fun stop()
}

/**
 * Returns the device's on-device speech recognition as a [SpeechInput], or null when the device
 * has none. The app never sends the user's voice to a recognition service off the device, so a
 * device without on-device recognition shows no mic.
 *
 * The first press asks for the microphone permission and does not listen; once the user has
 * granted it, a press listens.
 */
@Composable
fun rememberOnDeviceSpeechInput(): SpeechInput? {
    val context = LocalContext.current
    val available = remember(context) { SpeechRecognizer.isOnDeviceRecognitionAvailable(context) }
    if (!available) return null
    val askPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    val input = remember(context) { OnDeviceSpeechInput(context) { askPermission.launch(Manifest.permission.RECORD_AUDIO) } }
    DisposableEffect(input) { onDispose { input.destroy() } }
    return input
}

/**
 * A [SpeechInput] on the device's on-device recognizer. [askPermission] is called instead of
 * listening while the app lacks the microphone permission.
 */
private class OnDeviceSpeechInput(private val context: Context, private val askPermission: () -> Unit) : SpeechInput {
    private var recognizer: SpeechRecognizer? = null

    override fun start(onText: (String) -> Unit) {
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            askPermission()
            return
        }
        val listening = recognizer ?: SpeechRecognizer.createOnDeviceSpeechRecognizer(context).also { recognizer = it }
        listening.setRecognitionListener(ResultListener(onText))
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

/** Passes the best recognised text to [onText]; every other callback has nothing to do. */
private class ResultListener(private val onText: (String) -> Unit) : RecognitionListener {
    override fun onResults(results: Bundle) {
        results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            ?.firstOrNull()
            ?.takeIf { it.isNotBlank() }
            ?.let(onText)
    }

    override fun onReadyForSpeech(params: Bundle?) = Unit
    override fun onBeginningOfSpeech() = Unit
    override fun onRmsChanged(rmsdB: Float) = Unit
    override fun onBufferReceived(buffer: ByteArray?) = Unit
    override fun onEndOfSpeech() = Unit
    override fun onError(error: Int) = Unit
    override fun onPartialResults(partialResults: Bundle?) = Unit
    override fun onEvent(eventType: Int, params: Bundle?) = Unit
}
