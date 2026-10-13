package dev.hercule.android.alerts

import androidx.annotation.ColorInt
import androidx.core.graphics.drawable.IconCompat

/**
 * Draws the crew faces that alerts show. The face port implements it; alerts never draw a
 * face themselves. The seed is the session id for a thread and the assistant id for an
 * assistant, as everywhere else in the app.
 */
interface AlertFaces {
    /**
     * Returns the face as an adaptive icon, for a conversation's `Person` and its shortcut.
     * Android masks an adaptive icon to a circle, so the face sits inside the safe zone.
     */
    fun drawPersonIcon(seedId: String, isAssistant: Boolean, pose: AlertFacePose): IconCompat

    /** Returns a thread's face as a plain icon, for the tracker on its Live Update's track. */
    fun drawTrackerIcon(sessionId: String, pose: AlertFacePose): IconCompat

    /** Returns a thread's own colour (the face's `--who`), which its Live Update's done segments take. */
    @ColorInt
    fun readHueColor(sessionId: String): Int
}

/** The poses an alert draws a face in: the subset of the crew's poses alerts need. */
enum class AlertFacePose { Working, Waiting, Idle }
