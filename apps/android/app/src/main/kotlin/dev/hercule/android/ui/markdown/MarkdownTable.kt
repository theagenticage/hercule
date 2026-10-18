package dev.hercule.android.ui.markdown

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.IntrinsicMeasurable
import androidx.compose.ui.layout.IntrinsicMeasureScope
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.Measurable
import androidx.compose.ui.layout.MeasurePolicy
import androidx.compose.ui.layout.MeasureResult
import androidx.compose.ui.layout.MeasureScope
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import dev.hercule.android.markdown.ColumnAlignment
import dev.hercule.android.markdown.MarkdownBlock
import dev.hercule.android.markdown.MarkdownTableCell
import dev.hercule.android.theme.StrongWeight
import dev.hercule.android.ui.rememberChipPaddingSize
import kotlin.math.roundToInt

/*
 * A table, as markdown.tsx and markdown.css draw one: 14 sp text, the header row in bold, each
 * cell padded 4 dp above and below and 12 dp after its text, a hairline under every row, and
 * the whole table scrolling sideways on its own when it is wider than the message.
 *
 * Its columns are sized the way a browser sizes a table with `table-layout: auto`, without
 * border spacing, because the desktop's table collapses its borders:
 *
 * 1. Each cell is asked for its min-content width (its longest word, or its longest run that
 *    cannot wrap) and its max-content width (its text on one line), both with its padding.
 * 2. A column is at least as wide as the min-content width of its widest single-column cell,
 *    and would like to be as wide as the widest max-content width.
 * 3. A cell that spans several columns, narrowest span first, widens the columns it covers
 *    evenly when it needs more than they give it together, for its min and its max.
 * 4. The table is as wide as the message when its columns' max-content widths do not fit:
 *    - when the max-content widths fit, every column takes its max-content width, and the
 *      table is narrower than the message;
 *    - when even the min-content widths do not fit, every column takes its min-content width,
 *      and the table scrolls sideways;
 *    - otherwise each column takes its min-content width plus a share of the room left over,
 *      in proportion to how much more its max-content width asks for.
 * 5. Each cell is then measured once, at the width of the columns it covers, and a row is as
 *    tall as its tallest cell. A cell's text sits in the middle of its row, as a browser's
 *    `vertical-align: middle` puts it.
 *
 * Compose measures a child once per pass, so the widths come from intrinsic measurements, which
 * are allowed beside that one measure. Their cost: a text computes its intrinsic widths once,
 * keeps them until its text, style, font scale or layout direction changes, and lays out again
 * only for a new width. A table measured again, such as when the transcript scrolls it back
 * into view, does arithmetic over its cells and no text work. Nothing is cached here, so a
 * change of font scale or layout direction can leave no width behind.
 *
 * The table's available width comes in as its minimum width: the scroll container is as wide
 * as the message, and `horizontalScroll` passes its minimum width on while it lifts the maximum.
 */

/**
 * The most columns one cell may cover: the parser's cap on an HTML cell's `colspan`. A markdown
 * table keeps every column it has, however many, and scrolls sideways; only a span is capped,
 * so a table never allocates by a span nobody checked.
 */
private const val MAX_COLUMN_SPAN = 64

/** A table's cells in reading order, each with the first column it covers and how many it covers. */
private class TableGrid(val rows: List<List<MarkdownTableCell>>, val hasHeader: Boolean) {
    /** For each cell in reading order: its row, its first column and its span. */
    val rowOf: IntArray
    val firstColumnOf: IntArray
    val spanOf: IntArray
    val columns: Int

    init {
        val cells = rows.sumOf { it.size }
        rowOf = IntArray(cells)
        firstColumnOf = IntArray(cells)
        spanOf = IntArray(cells)
        var index = 0
        var widest = 0
        rows.forEachIndexed { row, cellsOfRow ->
            var column = 0
            cellsOfRow.forEach { cell ->
                val span = cell.columnSpan.coerceIn(1, MAX_COLUMN_SPAN)
                rowOf[index] = row
                firstColumnOf[index] = column
                spanOf[index] = span
                column += span
                index++
            }
            widest = maxOf(widest, column)
        }
        columns = maxOf(1, widest)
    }
}

/** Draws [table] in [style], each cell's text in [look] and acting through [actions]. */
@Composable
internal fun MarkdownTable(table: MarkdownBlock.Table, style: TextStyle, look: MarkdownLook, actions: MarkdownActions) {
    val grid = remember(table) { TableGrid(if (table.header.isEmpty()) table.rows else listOf(table.header) + table.rows, table.header.isNotEmpty()) }
    val cellStyle = look.small.copy(color = style.color)
    val chipPadding = rememberChipPaddingSize(look.buildCodeStyle(cellStyle.color))
    val policy = remember(grid) { TableMeasurePolicy(grid) }
    // Tells this table's rows from another's, for a copy that joins a row's cells with tabs.
    val tableIdentity = remember { Any() }
    // The scroll sits on the layout itself, not on a Box around it, because a Box would drop
    // the minimum width that brings the message's width to the measure below.
    Layout(
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        content = {
            grid.rows.forEachIndexed { row, cells ->
                val inHeader = grid.hasHeader && row == 0
                val rowStyle = if (inHeader) cellStyle.copy(fontWeight = StrongWeight) else cellStyle
                cells.forEach { cell ->
                    val codeStyle = look.buildCodeStyle(rowStyle.color)
                    val text = remember(cell, rowStyle, actions) { buildBlockText(cell.children, codeStyle, chipPadding, actions) }
                    MarkdownText(
                        text,
                        rowStyle.copy(textAlign = pickTextAlign(cell.align)),
                        look,
                        actions,
                        Modifier.padding(top = 4.dp, bottom = 4.dp, end = 12.dp),
                        row = TableRowPlace(tableIdentity, row),
                    )
                }
            }
            // One hairline under each row, the desktop's `box-shadow: inset 0 -1px 0 var(--line-soft)` on its cells.
            grid.rows.forEach { _ -> Box(Modifier.background(look.lineSoft)) }
        },
        measurePolicy = policy,
    )
}

/** Returns a cell's text alignment from its column's alignment; a column with none starts at the text's start. */
private fun pickTextAlign(align: ColumnAlignment?): TextAlign = when (align) {
    ColumnAlignment.Left -> TextAlign.Left
    ColumnAlignment.Center -> TextAlign.Center
    ColumnAlignment.Right -> TextAlign.Right
    null -> TextAlign.Start
}

/**
 * Lays out a table's cells, then its hairlines, by the algorithm at the top of this file. The
 * children are every cell of [grid] in reading order, then one hairline per row.
 */
private class TableMeasurePolicy(private val grid: TableGrid) : MeasurePolicy {
    override fun MeasureScope.measure(measurables: List<Measurable>, constraints: Constraints): MeasureResult {
        val cellCount = grid.rowOf.size
        val widths = computeColumnWidths(measurables, constraints.minWidth)
        val starts = IntArray(grid.columns + 1)
        for (column in 0 until grid.columns) starts[column + 1] = starts[column] + widths[column]
        val tableWidth = starts[grid.columns]

        val cells = List(cellCount) { index ->
            val first = grid.firstColumnOf[index]
            val last = minOf(grid.columns, first + grid.spanOf[index])
            measurables[index].measure(Constraints.fixedWidth(starts[last] - starts[first]))
        }
        val rowHeights = IntArray(grid.rows.size)
        cells.forEachIndexed { index, cell -> rowHeights[grid.rowOf[index]] = maxOf(rowHeights[grid.rowOf[index]], cell.height) }
        val rowTops = IntArray(grid.rows.size + 1)
        for (row in grid.rows.indices) rowTops[row + 1] = rowTops[row] + rowHeights[row]

        val hairline = 1.dp.roundToPx()
        val hairlines = List(grid.rows.size) { measurables[cellCount + it].measure(Constraints.fixed(tableWidth, hairline)) }
        val width = maxOf(tableWidth, constraints.minWidth).coerceAtMost(constraints.maxWidth)
        return layout(width, rowTops[grid.rows.size]) {
            cells.forEachIndexed { index, cell ->
                val row = grid.rowOf[index]
                cell.placeRelative(starts[grid.firstColumnOf[index]], rowTops[row] + (rowHeights[row] - cell.height) / 2)
            }
            hairlines.forEachIndexed { row, line -> line.placeRelative(0, rowTops[row + 1] - hairline) }
        }
    }

    /**
     * Returns each column's width in pixels for a table that has [available] pixels: steps 1 to 4
     * of the algorithm at the top of this file.
     */
    private fun computeColumnWidths(measurables: List<IntrinsicMeasurable>, available: Int): IntArray {
        val (mins, maxes) = computeColumnRanges(measurables)
        val minSum = mins.sum()
        val maxSum = maxes.sum()
        return when {
            maxSum <= available -> maxes
            minSum >= available -> mins
            else -> {
                val share = (available - minSum).toFloat() / (maxSum - minSum)
                // Each column's start is rounded, not each width, so the widths add up to the room.
                var placed = 0f
                var rounded = 0
                IntArray(grid.columns) { column ->
                    placed += mins[column] + (maxes[column] - mins[column]) * share
                    val end = placed.roundToInt()
                    (end - rounded).also { rounded = end }
                }
            }
        }
    }

    /** Returns each column's min-content and max-content width in pixels: steps 1 to 3 of the algorithm. */
    private fun computeColumnRanges(measurables: List<IntrinsicMeasurable>): Pair<IntArray, IntArray> {
        val mins = IntArray(grid.columns)
        val maxes = IntArray(grid.columns)
        val cellCount = grid.rowOf.size
        val cellMins = IntArray(cellCount) { measurables[it].minIntrinsicWidth(Constraints.Infinity) }
        val cellMaxes = IntArray(cellCount) { maxOf(cellMins[it], measurables[it].maxIntrinsicWidth(Constraints.Infinity)) }
        for (index in 0 until cellCount) {
            if (grid.spanOf[index] != 1) continue
            val column = grid.firstColumnOf[index]
            mins[column] = maxOf(mins[column], cellMins[index])
            maxes[column] = maxOf(maxes[column], cellMaxes[index])
        }
        (0 until cellCount).filter { grid.spanOf[it] > 1 }.sortedBy { grid.spanOf[it] }.forEach { index ->
            val first = grid.firstColumnOf[index]
            val last = minOf(grid.columns, first + grid.spanOf[index])
            widenEvenly(mins, first, last, cellMins[index])
            widenEvenly(maxes, first, last, cellMaxes[index])
        }
        for (column in 0 until grid.columns) maxes[column] = maxOf(maxes[column], mins[column])
        return mins to maxes
    }

    /** Widens the columns from [first] up to [last] of [widths] evenly, until together they are at least [needed] wide. */
    private fun widenEvenly(widths: IntArray, first: Int, last: Int, needed: Int) {
        val missing = needed - (first until last).sumOf { widths[it] }
        if (missing <= 0) return
        val count = last - first
        for (column in first until last) widths[column] += missing / count + if (column - first < missing % count) 1 else 0
    }

    // The table's own intrinsic widths, which a message bubble asks for to fit its text: the
    // columns' min-content widths or max-content widths added up.
    override fun IntrinsicMeasureScope.minIntrinsicWidth(measurables: List<IntrinsicMeasurable>, height: Int): Int =
        computeColumnRanges(measurables).first.sum()

    override fun IntrinsicMeasureScope.maxIntrinsicWidth(measurables: List<IntrinsicMeasurable>, height: Int): Int =
        computeColumnRanges(measurables).second.sum()
}
