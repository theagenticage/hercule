package dev.hercule.android.ui

import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.time.Instant

private val ClockFormat = DateTimeFormatter.ofPattern("HH:mm")

/** Formats [at] as the clock time in [zone], such as "09:04", as the book writes a message's time. */
fun formatClockTime(at: Instant, zone: ZoneId): String =
    ClockFormat.format(java.time.Instant.ofEpochMilli(at.toEpochMilliseconds()).atZone(zone))
