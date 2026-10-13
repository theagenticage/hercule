package dev.hercule.android.office

import kotlin.time.Duration
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.hours
import kotlin.time.Instant

/**
 * Returns the time from [at] to [now] in the largest unit that fits, such as "now", "5m", "3h",
 * "2d" or "1w". A row is scanned, not read to the second, so under a minute is "now". An [at]
 * later than [now], which happens when two machines' clocks disagree, also reads "now", so an
 * age is never negative.
 *
 * Ported from `formatAge` in packages/client-core/src/threads/age.ts.
 */
fun formatAge(at: Instant, now: Instant): String {
    val elapsed = (now - at).coerceAtLeast(Duration.ZERO)
    return when {
        elapsed.inWholeMinutes == 0L -> "now"
        elapsed < 1.hours -> "${elapsed.inWholeMinutes}m"
        elapsed < 1.days -> "${elapsed.inWholeHours}h"
        elapsed < 7.days -> "${elapsed.inWholeDays}d"
        else -> "${elapsed.inWholeDays / 7}w"
    }
}
