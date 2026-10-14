package dev.hercule.android

import android.Manifest
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.NavBackStack
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import dev.hercule.android.alerts.AlertKey
import dev.hercule.android.alerts.AssistantAlertKey
import dev.hercule.android.alerts.EXTRA_ALERT_DESTINATION
import dev.hercule.android.alerts.ThreadAlertKey
import dev.hercule.android.app.AppGraph
import dev.hercule.android.app.BackgroundPermissions
import dev.hercule.android.ui.BureauTheme
import dev.hercule.android.ui.ShowCallFailures
import dev.hercule.android.ui.Tab
import dev.hercule.android.ui.assistant.AssistantScreen
import dev.hercule.android.ui.assistant.AssistantViewModel
import dev.hercule.android.ui.assistant.rememberOnDeviceSpeechInput
import dev.hercule.android.ui.bureauColors
import dev.hercule.android.ui.you.YouScreen
import dev.hercule.android.ui.you.YouViewModel
import dev.hercule.android.ui.office.OfficeScreen
import dev.hercule.android.ui.office.OfficeViewModel
import dev.hercule.android.ui.signin.SignInScreen
import dev.hercule.android.ui.signin.SignInViewModel
import dev.hercule.android.ui.thread.ThreadScreen
import dev.hercule.android.ui.thread.ThreadViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/**
 * The app's single activity: the five screens behind one back stack, drawn edge to edge.
 *
 * An alert's tap opens it at the alert's destination. The activity is `singleTop`, so a tap
 * while it is open arrives in [onNewIntent] instead of stacking a second activity.
 */
class MainActivity : ComponentActivity() {
    /** The destination of the last alert tapped, until the back stack has opened it. */
    private val alertDestination = MutableStateFlow<AlertKey?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // After a recreation the saved back stack already shows the alert's destination.
        if (savedInstanceState == null) alertDestination.value = readAlertDestination(intent)
        setContent {
            BureauTheme {
                AppNavigation(appGraph, alertDestination)
            }
        }
    }

    override fun onStart() {
        super.onStart()
        // A failure can stop the controller watch service while the phone stays signed in, and
        // the alert that says so asks the user to open the app. Coming to the front starts it.
        lifecycleScope.launch { appGraph.startStoppedControllerWatchService() }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        readAlertDestination(intent)?.let { alertDestination.value = it }
    }
}

/** Reads the destination of the alert that opened [intent], or null when no alert did. */
private fun readAlertDestination(intent: Intent): AlertKey? =
    intent.getStringExtra(EXTRA_ALERT_DESTINATION)?.let(AlertKey::parse)

/** The app's destinations, one per screen. */
@Serializable
private sealed interface Destination : NavKey {
    @Serializable
    data object SignIn : Destination

    @Serializable
    data object Office : Destination

    @Serializable
    data class Thread(val sessionId: String) : Destination

    @Serializable
    data class Assistant(val assistantId: String) : Destination

    @Serializable
    data object You : Destination
}

/**
 * Reads the stored sign-in once per activity, which also starts the controller watch service when
 * the phone is signed in. [start] is null until the read is done, then the Office or sign-in.
 *
 * A sign-in that runs, or that failed while its screen was closed, opens sign-in, which shows it.
 *
 * It is a ViewModel so that a rotation, which recreates the activity, does not read and start
 * again.
 */
private class StartViewModel(graph: AppGraph) : ViewModel() {
    val start: StateFlow<Destination?> =
        flow {
            val start = when {
                graph.findUnseenSignIn() != null -> Destination.SignIn
                graph.restoreSignIn() -> Destination.Office
                else -> Destination.SignIn
            }
            emit(start)
        }
            .stateIn(viewModelScope, SharingStarted.Eagerly, null)
}

/**
 * Draws a blank page until the stored sign-in is read, then the back stack: the Office when
 * the phone is signed in, sign-in otherwise.
 */
@Composable
private fun AppNavigation(graph: AppGraph, alertDestination: MutableStateFlow<AlertKey?>) {
    val startViewModel = viewModel { StartViewModel(graph) }
    val startDestination by startViewModel.start.collectAsStateWithLifecycle()
    val start = startDestination
    if (start == null) {
        BlankPage()
    } else {
        BackStackDisplay(graph, start, alertDestination)
    }
}

/** Draws the screen on top of the back stack, which starts at [start]. */
@Composable
private fun BackStackDisplay(graph: AppGraph, start: Destination, alertDestination: MutableStateFlow<AlertKey?>) {
    val backStack = rememberNavBackStack(start)

    LaunchedEffect(backStack) {
        alertDestination.filterNotNull().collect { key ->
            alertDestination.value = null
            val destination = when (key) {
                is ThreadAlertKey -> Destination.Thread(key.sessionId)
                is AssistantAlertKey -> Destination.Assistant(key.assistantId)
            }
            // Signed out, an alert has nothing to open; sign-in stays in front. An alert for the
            // screen already in front leaves the stack alone, so that screen stays marked on screen.
            val top = backStack.lastOrNull()
            if (top == Destination.SignIn || top == destination) return@collect
            backStack.replaceAll(Destination.Office)
            backStack.add(destination)
        }
    }
    LaunchedEffect(backStack) {
        // Whatever clears the credentials opens sign-in: the user signing out, or a sign-in the
        // controller stopped accepting, which is ended without the user asking.
        graph.hasCredentials.collect { hasCredentials ->
            if (!hasCredentials && backStack.lastOrNull() != Destination.SignIn) backStack.replaceAll(Destination.SignIn)
        }
    }

    AskBackgroundPermissionsAfterSignIn(graph, isSignInShown = backStack.lastOrNull() == Destination.SignIn)

    NavDisplay(
        backStack = backStack,
        onBack = { backStack.removeLastOrNull() },
        entryDecorators = listOf(rememberSaveableStateHolderNavEntryDecorator(), rememberViewModelStoreNavEntryDecorator()),
        entryProvider = entryProvider {
            entry<Destination.SignIn> {
                val viewModel = viewModel { SignInViewModel(graph) }
                val state by viewModel.state.collectAsStateWithLifecycle()
                val succeededSignIn by viewModel.succeededSignIn.collectAsStateWithLifecycle()
                LaunchedEffect(viewModel) {
                    // The back stack comes back on sign-in, signed in, when Android ended the
                    // process just after a sign-in. A sign-in this screen shows, running or
                    // failed, stays on screen.
                    val state = viewModel.state.value
                    if (graph.isSignedIn() && viewModel.succeededSignIn.value == null && !state.signingIn && state.error == null) {
                        backStack.replaceAll(Destination.Office)
                    }
                }
                LaunchedEffect(succeededSignIn) {
                    // The credentials can be cleared again before this runs, by a refused key.
                    // Sign-in then stays in front, until a retry succeeds.
                    if (succeededSignIn != null && graph.isSignedIn()) backStack.replaceAll(Destination.Office)
                }
                SignInScreen(state, onSignIn = viewModel::signIn, onEdit = viewModel::clearError)
            }
            entry<Destination.Office> {
                val viewModel = viewModel { OfficeViewModel(graph) }
                val state by viewModel.state.collectAsStateWithLifecycle()
                ShowCallFailures(viewModel.calls)
                val office = state
                if (office == null) {
                    BlankPage()
                } else {
                    OfficeScreen(
                        office,
                        onOpen = { row ->
                            val assistantId = row.assistantId
                            val sessionId = row.sessionId
                            when {
                                assistantId != null -> backStack.add(Destination.Assistant(assistantId))
                                sessionId != null -> backStack.add(Destination.Thread(sessionId))
                            }
                        },
                        onDecide = viewModel::decide,
                        onSelectTab = { tab -> if (tab == Tab.You) backStack.replaceAll(Destination.You) },
                    )
                }
            }
            entry<Destination.Thread> { destination ->
                val viewModel = viewModel { ThreadViewModel(graph, destination.sessionId) }
                val state by viewModel.state.collectAsStateWithLifecycle()
                ShowCallFailures(viewModel.calls)
                MarkOnScreen(graph, ThreadAlertKey(destination.sessionId))
                val thread = state
                if (thread == null) {
                    BlankPage()
                } else {
                    ThreadScreen(
                        thread,
                        onBack = { backStack.removeLastOrNull() },
                        onDecide = viewModel::decide,
                        onAnswer = viewModel::answer,
                        onSend = viewModel::send,
                    )
                }
            }
            entry<Destination.Assistant> { destination ->
                val viewModel = viewModel { AssistantViewModel(graph, destination.assistantId) }
                val state by viewModel.state.collectAsStateWithLifecycle()
                ShowCallFailures(viewModel.calls)
                MarkOnScreen(graph, AssistantAlertKey(destination.assistantId))
                // Asked here, not when the app opens, because only this screen draws the mic.
                val speechInput = rememberOnDeviceSpeechInput(onFailure = viewModel.calls::report)
                val assistant = state
                if (assistant == null) {
                    BlankPage()
                } else {
                    AssistantScreen(
                        assistant,
                        onBack = { backStack.removeLastOrNull() },
                        onSend = viewModel::send,
                        onDecide = viewModel::decide,
                        onAnswer = viewModel::answer,
                        speechInput = speechInput,
                    )
                }
            }
            entry<Destination.You> {
                val context = LocalContext.current
                val viewModel = viewModel { YouViewModel(graph, context.applicationContext.assets) }
                val state by viewModel.state.collectAsStateWithLifecycle()
                val connection = state
                if (connection == null) {
                    BlankPage()
                } else {
                    YouScreen(
                        connection,
                        onSignOut = viewModel::signOut,
                        onSelectTab = { tab -> if (tab == Tab.Office) backStack.replaceAll(Destination.Office) },
                    )
                }
            }
        },
    )
}

/**
 * Asks, once after each sign-in, for what alerts need in the background: the permission to post
 * notifications when it is missing, then the battery exemption when it was never asked. Starts
 * the controller watch service when the user allows notifications.
 *
 * It asks when the app is in front and past the sign-in screen, whichever screen that is. A
 * sign-in that ended while the app was in the background, or with its screen closed, is asked
 * about when the user comes back.
 */
@Composable
private fun AskBackgroundPermissionsAfterSignIn(graph: AppGraph, isSignInShown: Boolean) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val permissions = graph.backgroundPermissions
    val askBatteryExemption = { scope.launch { askBatteryExemptionOnce(context, permissions) } }
    val notificationLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        if (allowed) graph.startControllerWatchService()
        askBatteryExemption()
    }
    LifecycleStartEffect(isSignInShown) {
        if (!isSignInShown && graph.claimBackgroundPermissionsAsk()) {
            if (permissions.needsNotificationPermission()) {
                notificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                askBatteryExemption()
            }
        }
        onStopOrDispose {}
    }
}

/** Opens the system's battery exemption dialog, unless the app is exempt or asked before. */
private suspend fun askBatteryExemptionOnce(context: Context, permissions: BackgroundPermissions) {
    if (!permissions.shouldAskBatteryExemption()) return
    context.startActivity(permissions.buildBatteryExemptionIntent())
    permissions.recordBatteryExemptionAsked()
}

/**
 * Marks [key]'s destination as the one on screen while the app is in front, so that nothing
 * alerts for it, and clears the mark when the app goes to the background or the screen closes.
 */
@Composable
private fun MarkOnScreen(graph: AppGraph, key: AlertKey) {
    LifecycleStartEffect(key) {
        graph.keyOnScreen.value = key
        onStopOrDispose {
            graph.keyOnScreen.compareAndSet(key, null)
        }
    }
}

/** Draws the page's background alone, while what a screen shows is still being read. */
@Composable
private fun BlankPage() {
    Box(Modifier.fillMaxSize().background(bureauColors.bg))
}

/** Replaces the whole back stack with [destination], as switching tabs or signing in does. */
private fun NavBackStack<NavKey>.replaceAll(destination: Destination) {
    clear()
    add(destination)
}
