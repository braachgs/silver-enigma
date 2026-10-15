package dayboard.core

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

enum class Align { LEFT, CENTER, RIGHT }

/** The few drawing calls the board needs, so it renders on Android (Canvas) and on the JVM (Java2D) alike. */
interface Painter {
    fun rect(x: Float, y: Float, w: Float, h: Float, color: Int, radius: Float = 0f)

    /** Text in the flap typeface. [x] is the left edge, centre or right edge, per [align]. */
    fun text(s: String, x: Float, baseline: Float, size: Float, color: Int, align: Align = Align.LEFT, tracking: Float = 0f)

    fun measure(s: String, size: Float, tracking: Float = 0f): Float

    /** Height of a capital letter at [size], to centre glyphs in their flaps. */
    fun capHeight(size: Float): Float
}

/** Colours from the web app's split-flap style (css/app.css). */
object Palette {
    const val BACKGROUND = 0xFF161616.toInt()
    const val RULE = 0xFFF2B705.toInt()
    const val INK = 0xFFF4F1E6.toInt()
    const val DIM = 0xFFA39E8F.toInt()
    const val DIVIDER = 0xFF262626.toInt()
    const val CELL_TOP = 0xFF2A2A2A.toInt()
    const val CELL_BOTTOM = 0xFF1B1B1B.toInt()
    const val LIVE_TOP = 0xFF31904A.toInt()
    const val LIVE_BOTTOM = 0xFF22683A.toInt()
    const val SPLIT = 0x8C000000.toInt()
    const val TILE_SPLIT = 0x59000000

    fun ink(tone: Tone): Int = when (tone) {
        Tone.ON_TIME -> 0xFF93DD73.toInt()
        Tone.BOARDING -> 0xFFFFC233.toInt()
        Tone.FINAL -> 0xFFFF7A45.toInt()
        Tone.LIVE -> 0xFFFFFFFF.toInt()
        Tone.INFO -> 0xFFD6D1C3.toInt()
        Tone.PAST -> 0xFF8A8578.toInt()
    }

    /** Dark ink on light line colours (yellow, white), white on the rest. */
    fun tileInk(color: Int): Int {
        fun lin(c: Int): Double { val v = c / 255.0; return if (v <= 0.03928) v / 12.92 else Math.pow((v + 0.055) / 1.055, 2.4) }
        val l = 0.2126 * lin(color shr 16 and 0xFF) + 0.7152 * lin(color shr 8 and 0xFF) + 0.0722 * lin(color and 0xFF)
        return if (l > 0.45) 0xFF111111.toInt() else 0xFFFFFFFF.toInt()
    }
}

/**
 * Where everything goes on a board of [w] x [h] pixels at [d] pixels per dp.
 * Narrow boards put the title on its own line of flaps under the time and
 * remark, as the web app's rows do; wide boards fit a row on one line.
 */
class BoardLayout(val w: Float, val h: Float, val d: Float, val hour12: Boolean) {
    /** Short widgets (a 2-row home-screen widget) get tighter margins. */
    private val compact = h < 190 * d
    val pad = (if (compact) 8 else 10) * d
    val headerH = (if (compact) 20 else 24) * d
    val ruleY = pad + headerH
    val ruleH = 2 * d
    val gap = max(1f, 1f * d)
    val sectionGap = 6 * d
    val contentW = w - 2 * pad
    val timeCells = if (hour12) 6 else 5
    val remarkCells = 10
    val lineGap = 3 * d
    val rowGap = (if (compact) 6 else 8) * d
    val rowsTop = ruleY + ruleH + (if (compact) 5 else 7) * d
    val footerH = (if (compact) 14 else 16) * d
    val rowsBottom = h - pad - footerH

    val oneLine: Boolean
    val cw: Float
    val ch: Float
    val tileW: Float
    val titleCells: Int

    init {
        // Try one line per row at a comfortable cell size first.
        val wide = 11 * d
        val wideTitle = floor((contentW - wide * TILE - 3 * sectionGap - (timeCells + remarkCells) * (wide + gap)) / (wide + gap)).toInt()
        oneLine = wideTitle >= 14
        var c = if (oneLine) {
            wide
        } else {
            // Top line: tile, time, remark. Size the cells so that line fits.
            val fit = (contentW - 2 * sectionGap - (timeCells + remarkCells) * gap) / (TILE + timeCells + remarkCells)
            min(12 * d, max(7 * d, fit))
        }
        // Then, if only one row would fit, shrink the cells (to no less than
        // 8.5dp) so a second departure fits too.
        val area = rowsBottom - rowsTop
        val lines = if (oneLine) 1 else 2
        if (rowCount(c, lines, area) < 2) {
            val ch2 = (area - rowGap - 2 * (lines - 1) * lineGap) / (2 * lines)
            val c2 = ch2 / ASPECT
            if (c2 >= 8.5f * d) c = min(c, c2)
        }
        cw = c
        ch = cw * ASPECT
        tileW = cw * TILE
        titleCells = if (oneLine) {
            floor((contentW - tileW - 3 * sectionGap - (timeCells + remarkCells) * (cw + gap)) / (cw + gap)).toInt()
        } else {
            floor((contentW - tileW - sectionGap + gap) / (cw + gap)).toInt()
        }
    }

    private fun rowCount(c: Float, lines: Int, area: Float): Int {
        val rowH = c * ASPECT * lines + (lines - 1) * lineGap
        return floor((area + rowGap) / (rowH + rowGap)).toInt()
    }

    val fontSize get() = ch * 0.82f
    val rowH get() = if (oneLine) ch else ch * 2 + lineGap

    /** How many rows fit; the board always shows at least one. */
    val capacity: Int get() = max(1, floor((rowsBottom - rowsTop + rowGap) / (rowH + rowGap)).toInt())

    val timeX get() = pad + tileW + sectionGap
    val remarkX get() = w - pad - remarkCells * (cw + gap) + gap
    val titleX get() = if (oneLine) timeX + timeCells * (cw + gap) + sectionGap else timeX

    companion object {
        /** Cell height : width, as the web app's flaps. */
        const val ASPECT = 1.9f
        /** Line tile width, in cells. */
        const val TILE = 3.3f
    }
}

/** Draws a [BoardModel] in the split-flap style. */
class BoardRenderer(private val cornerRadius: Float = 16f) {

    /**
     * [clock] draws a time in the header; the Android widget leaves it null
     * and lays a live TextClock over that corner instead.
     */
    fun draw(p: Painter, model: BoardModel, layout: BoardLayout, clock: String? = null) {
        val l = layout
        val d = l.d
        p.rect(0f, 0f, l.w, l.h, Palette.BACKGROUND, cornerRadius * d)

        // Header: DEPARTURES · THU 15 OCT, the amber rule under it.
        val hs = 12 * d
        val hb = l.pad + l.headerH / 2 + p.capHeight(hs) / 2
        p.text("DEPARTURES", l.pad + 2 * d, hb, hs, Palette.DIM, tracking = 0.14f)
        val dx = l.pad + 2 * d + p.measure("DEPARTURES", hs, 0.14f) + 10 * d
        p.text(model.dayLabel, dx, hb, hs, Palette.INK, tracking = 0.1f)
        if (clock != null) p.text(clock, l.w - l.pad - 2 * d, hb + d, 15 * d, Palette.RULE, Align.RIGHT, 0.04f)
        p.rect(0f, l.ruleY, l.w, l.ruleH, Palette.RULE)

        if (model.rows.isEmpty()) {
            drawMessage(p, model.message ?: "NO DEPARTURES TODAY", l)
        } else {
            model.rows.forEachIndexed { i, row ->
                val y = l.rowsTop + i * (l.rowH + l.rowGap)
                if (i > 0) p.rect(l.pad, y - l.rowGap / 2 - d / 2, l.contentW, max(1f, d * 0.75f), Palette.DIVIDER)
                drawRow(p, row, y, l)
            }
        }
        drawFooter(p, model, l)
    }

    private fun drawRow(p: Painter, row: Row, y: Float, l: BoardLayout) {
        val d = l.d
        // Line tile: the code on a coloured flap.
        p.rect(l.pad, y, l.tileW, l.ch, row.line.color, 2.5f * d)
        p.text(row.line.code.take(3).uppercase(), l.pad + l.tileW / 2, y + l.ch / 2 + p.capHeight(l.fontSize * 0.86f) / 2,
            l.fontSize * 0.86f, Palette.tileInk(row.line.color), Align.CENTER, 0.06f)
        p.rect(l.pad, y + l.ch / 2 - d / 2, l.tileW, max(1f, d * 0.75f), Palette.TILE_SPLIT)

        val timeInk = if (row.tomorrow) Palette.ink(Tone.INFO) else Palette.INK
        cells(p, row.time, l.timeX, y, l.timeCells, l, timeInk)

        val live = row.remark.tone == Tone.LIVE
        cells(p, row.remark.text.padEnd(l.remarkCells), l.remarkX, y, l.remarkCells, l, Palette.ink(row.remark.tone), live)

        val ty = if (l.oneLine) y else y + l.ch + l.lineGap
        val n = l.titleCells
        if (Flap.legible(row.event.title)) {
            cells(p, Flap.fit(row.event.title, n), l.titleX, ty, n, l, if (row.tomorrow) Palette.ink(Tone.INFO) else Palette.INK)
        } else {
            // Non-Latin titles and emoji as plain text: flaps would blank them out.
            val size = l.fontSize
            val maxW = n * (l.cw + l.gap)
            p.text(ellipsize(p, row.event.title, size, maxW), l.titleX, ty + l.ch / 2 + p.capHeight(size) / 2, size, Palette.INK)
        }
    }

    private fun cells(p: Painter, text: String, x: Float, y: Float, n: Int, l: BoardLayout, ink: Int, live: Boolean = false) {
        val d = l.d
        val top = if (live) Palette.LIVE_TOP else Palette.CELL_TOP
        val bottom = if (live) Palette.LIVE_BOTTOM else Palette.CELL_BOTTOM
        val r = 1.5f * d
        val baseline = y + l.ch / 2 + p.capHeight(l.fontSize) / 2
        for (i in 0 until n) {
            val cx = x + i * (l.cw + l.gap)
            p.rect(cx, y, l.cw, l.ch, top, r)
            p.rect(cx, y + l.ch / 2, l.cw, l.ch / 2, bottom, r)
            p.rect(cx, y + l.ch / 2, l.cw, r, bottom)
            val c = text.getOrNull(i)
            if (c != null && c != ' ') p.text(c.toString(), cx + l.cw / 2, baseline, l.fontSize, ink, Align.CENTER)
            p.rect(cx, y + l.ch / 2 - d * 0.3f, l.cw, max(1f, d * 0.6f), Palette.SPLIT)
        }
    }

    private fun drawMessage(p: Painter, message: String, l: BoardLayout) {
        val n = floor((l.contentW + l.gap) / (l.cw + l.gap)).toInt()
        val words = Flap.clean(message).trim()
        // Up to two lines of flaps, centred.
        val lines = wrap(words, n).take(2)
        val blockH = lines.size * l.ch + (lines.size - 1) * l.lineGap
        val mid = (l.rowsTop + l.rowsBottom) / 2
        lines.forEachIndexed { i, line ->
            val w = line.length * (l.cw + l.gap) - l.gap
            cells(p, line, (l.w - w) / 2, mid - blockH / 2 + i * (l.ch + l.lineGap), line.length, l, Palette.INK)
        }
    }

    private fun drawFooter(p: Painter, model: BoardModel, l: BoardLayout) {
        val d = l.d
        val size = 10.5f * d
        val baseline = l.h - l.pad - (l.footerH - p.capHeight(size)) / 2
        val more = if (model.moreToday > 0) "+${model.moreToday} MORE TODAY" else ""
        val moreW = if (more.isEmpty()) 0f else p.measure(more, size, 0.08f)
        if (more.isNotEmpty()) p.text(more, l.w - l.pad, baseline, size, Palette.DIM, Align.RIGHT, 0.08f)
        if (model.allDay.isNotEmpty()) {
            val titles = model.allDay.joinToString(", ") { it.title }
            val label = "ALL DAY · " + titles.uppercase()
            val maxW = l.contentW - moreW - if (more.isEmpty()) 0f else 12 * d
            p.text(ellipsize(p, label, size, maxW, 0.08f), l.pad, baseline, size, Palette.DIM, tracking = 0.08f)
        }
    }

    companion object {
        fun ellipsize(p: Painter, s: String, size: Float, maxW: Float, tracking: Float = 0f): String {
            if (p.measure(s, size, tracking) <= maxW) return s
            var lo = 0
            var hi = s.length
            while (lo < hi) {
                val mid = (lo + hi + 1) / 2
                if (p.measure(s.take(mid).trimEnd() + "…", size, tracking) <= maxW) lo = mid else hi = mid - 1
            }
            return if (lo == 0) "" else s.take(lo).trimEnd() + "…"
        }

        /** Word-wrap into lines of at most [width] characters; overlong words are cut. */
        fun wrap(s: String, width: Int): List<String> {
            if (width <= 0) return emptyList()
            val out = ArrayList<String>()
            var cur = ""
            for (word in s.split(' ').filter { it.isNotEmpty() }) {
                var w = word
                while (w.length > width) {
                    if (cur.isNotEmpty()) { out += cur; cur = "" }
                    out += w.take(width); w = w.drop(width)
                }
                cur = when {
                    w.isEmpty() -> cur
                    cur.isEmpty() -> w
                    cur.length + 1 + w.length <= width -> "$cur $w"
                    else -> { out += cur; w }
                }
            }
            if (cur.isNotEmpty()) out += cur
            return out
        }
    }
}
