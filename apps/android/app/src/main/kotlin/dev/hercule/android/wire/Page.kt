package dev.hercule.android.wire

import kotlinx.serialization.Serializable

/**
 * One page of any list operation. `nextCursor` is absent on the last page. To read the next
 * page, send it back as `cursor` together with the same `sort` and filters as before.
 */
@Serializable
data class Page<T>(
    val items: List<T>,
    val nextCursor: String? = null,
)
