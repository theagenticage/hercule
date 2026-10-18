package dev.hercule.android.ui.markdown

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import dev.hercule.android.markdown.MarkdownBlock
import dev.hercule.android.markdown.MarkdownDocument
import dev.hercule.android.markdown.MarkdownInline
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/*
 * What a drawn message remembers about itself: which details blocks the user opened, and where
 * its footnote links lead.
 *
 * A block is named by its path in the document: the indexes that lead to it from the top, such
 * as "2.1.0" for the first block of the second item of the list that is the third block. A
 * footnote's blocks start with "fn" and the footnote's number, such as "fn1.0". This is how the
 * desktop keeps a details block open: React matches elements by their place in the tree, so
 * the browser's own open state follows the block's path. While a message streams, its settled
 * text only grows at its end, so the path of a block already drawn never changes.
 */

/** Returns the path of the [index]th block under the block at [parent], or at the top when [parent] is empty. */
internal fun buildChildPath(parent: String, index: Int): String = if (parent.isEmpty()) "$index" else "$parent.$index"

/** Returns the path of the top of footnote [number]'s blocks. */
internal fun buildFootnotePath(number: Int): String = "fn$number"

/** The details blocks of one message that the user has opened, by path. Every one starts shut. */
@Stable
internal class DetailsState(opened: Set<String> = emptySet()) {
    var opened by mutableStateOf(opened)
        private set

    /** Checks whether the details block at [path] is open. */
    fun isOpen(path: String): Boolean = path in opened

    /** Opens the details block at [path] when it is shut, and shuts it when it is open. */
    fun toggle(path: String) {
        opened = if (path in opened) opened - path else opened + path
    }

    /** Opens every details block in [paths]. */
    fun open(paths: Collection<String>) {
        if (!opened.containsAll(paths)) opened = opened + paths
    }

    companion object {
        /** Saves the open paths as a list of strings, so the state outlives the row leaving the screen. */
        val Saver = Saver<DetailsState, ArrayList<String>>(save = { ArrayList(it.opened) }, restore = { DetailsState(it.toSet()) })
    }
}

/** Where a footnote link leads in a message. */
internal sealed interface FootnoteTarget {
    /** The footnote with this [number], in the section under the message. */
    data class Note(val number: Int) : FootnoteTarget

    /** The first reference to footnote [number] in the message's text, where its back link leads. */
    data class Reference(val number: Int) : FootnoteTarget
}

/**
 * Returns, for each footnote of [document] that the text references, the paths of the details
 * blocks around its first reference, outermost first. A reference outside any details block
 * has an empty list. The footnotes themselves sit outside every details block, in their own
 * section.
 */
internal fun findReferenceDetails(document: MarkdownDocument): Map<Int, List<String>> {
    val found = HashMap<Int, List<String>>()
    fun visitInlines(inlines: List<MarkdownInline>, around: List<String>) {
        inlines.forEach { inline ->
            when (inline) {
                is MarkdownInline.FootnoteReference -> if (inline.isFirstReference) found.putIfAbsent(inline.number, around)
                is MarkdownInline.Strong -> visitInlines(inline.children, around)
                is MarkdownInline.Emphasis -> visitInlines(inline.children, around)
                is MarkdownInline.Strikethrough -> visitInlines(inline.children, around)
                is MarkdownInline.Link -> visitInlines(inline.children, around)
                else -> Unit
            }
        }
    }
    fun visitBlocks(blocks: List<MarkdownBlock>, parent: String, around: List<String>) {
        blocks.forEachIndexed { index, block ->
            val path = buildChildPath(parent, index)
            when (block) {
                is MarkdownBlock.Paragraph -> visitInlines(block.children, around)
                is MarkdownBlock.Heading -> visitInlines(block.children, around)
                is MarkdownBlock.List -> block.items.forEachIndexed { item, it -> visitBlocks(it.children, buildChildPath(path, item), around) }
                is MarkdownBlock.Blockquote -> visitBlocks(block.children, path, around)
                is MarkdownBlock.Table -> (listOf(block.header) + block.rows).forEach { row -> row.forEach { visitInlines(it.children, around) } }
                is MarkdownBlock.Details -> {
                    // The summary shows while the block is shut, so a reference in it needs no opening.
                    visitInlines(block.summary, around)
                    visitBlocks(block.children, path, around + path)
                }
                is MarkdownBlock.Code, MarkdownBlock.Rule -> Unit
            }
        }
    }
    visitBlocks(document.blocks, "", emptyList())
    document.footnotes.forEach { visitBlocks(it.children, buildFootnotePath(it.number), emptyList()) }
    return found
}

/**
 * Takes the reader to the targets of one message's footnote links: from a reference to its
 * footnote, and from a footnote's back link to the first reference.
 *
 * The message is one row of the transcript's lazy list, so a target is not a place in a page
 * that the list can scroll to by itself. Each target registers here, while it is drawn, how to
 * bring itself into view; the list then scrolls as far as it needs to. A first reference inside
 * a shut details block is not drawn at all, so [goTo] opens the blocks around it first, waits
 * until the reference is drawn and laid out, and then brings it into view.
 *
 * [scope] runs that wait; [details] are the message's details blocks, and [referenceDetails]
 * holds the blocks around each first reference, from [findReferenceDetails].
 */
@Stable
internal class FootnoteNavigator(private val scope: CoroutineScope, private val details: DetailsState) {
    var referenceDetails: Map<Int, List<String>> = emptyMap()

    private val targets = mutableStateMapOf<FootnoteTarget, suspend () -> Unit>()

    /** The wait of the last tap, cancelled by the next one so a target never drawn holds no wait. */
    private var going: Job? = null

    /** Registers [bringIntoView] as the way to show [target], while the target is drawn. */
    fun register(target: FootnoteTarget, bringIntoView: suspend () -> Unit) {
        targets[target] = bringIntoView
    }

    /** Removes [target], once it is no longer drawn, unless another drawing has taken its place. */
    fun unregister(target: FootnoteTarget, bringIntoView: suspend () -> Unit) {
        if (targets[target] === bringIntoView) targets.remove(target)
    }

    /**
     * Brings [target] into view, opening the details blocks around it first. A target that is
     * never drawn, such as a footnote the settled text does not hold yet, is never reached.
     */
    fun goTo(target: FootnoteTarget) {
        if (target is FootnoteTarget.Reference) details.open(referenceDetails[target.number].orEmpty())
        going?.cancel()
        going = scope.launch {
            val bringIntoView = snapshotFlow { targets[target] }.filterNotNull().first()
            // A target that a details block just showed registers while it is composed; its
            // place is known once the frame after that has laid it out.
            withFrameNanos {}
            bringIntoView()
        }
    }
}
