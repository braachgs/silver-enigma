package dayboard.match

import dayboard.core.Align
import dayboard.core.BoardLayout
import dayboard.core.BoardRenderer
import dayboard.core.Flap
import dayboard.core.Painter
import dayboard.core.Palette
import dayboard.core.Tone
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * Where everything goes on a Match Board of [w] x [h] pixels at [d] pixels
 * per dp, sized like Day Board's (dayboard.core.BoardLayout). Narrow boards
 * put kickoff and status on one line and the scoreline under them; wide
 * boards fit a match on one line.
 */
class MatchLayout(val w: Float, val h: Float, val d: Float) {
    private val compact = h < 190 * d
    /** Tall boards (Edge slots, big widgets) start each day with a line; shorter ones keep the day in the row. */
    val dayLines = h >= 260 * d
    val pad = (if (compact) 8 else 10) * d
    val headerH = (if (compact) 20 else 24) * d
    val ruleY = pad + headerH
    val ruleH = 2 * d
    val gap = max(1f, 1f * d)
    val sectionGap = 6 * d
    val contentW = w - 2 * pad
    val timeCells = 6
    val statusCells = 10
    val lineGap = 3 * d
    val rowGap = (if (compact) 6 else 8) * d
    val rowsTop = ruleY + ruleH + (if (compact) 5 else 7) * d
    val footerH = (if (compact) 14 else 16) * d
    val rowsBottom = h - pad - footerH

    val oneLine: Boolean
    val cw: Float
    val ch: Float
    val nameCells: Int

    /** A score tile is a little wider than a flap, so "10" fits. */
    val scoreW get() = cw * 1.5f

    init {
        val wide = 11 * d
        oneLine = names(wide, true) >= NAME_TARGET
        var c = if (oneLine) wide else {
            // Fit the top line (kickoff, status) and a scoreline with 10-flap names ("MAN UNITED").
            val top = (contentW - sectionGap - (timeCells + statusCells) * gap) / (timeCells + statusCells)
            val scoreline = (contentW - 2 * NAME_TARGET * gap - 2 * sectionGap) / (2 * NAME_TARGET + 3)
            min(12 * d, max(7 * d, min(top, scoreline)))
        }
        // As Day Board: if only one match would fit, shrink the flaps (to no less than 8.5dp) to fit two.
        val lines = if (oneLine) 1 else 2
        val area = rowsBottom - rowsTop
        val rowH = c * BoardLayout.ASPECT * lines + (lines - 1) * lineGap
        if (floor((area + rowGap) / (rowH + rowGap)) < 2) {
            val c2 = (area - rowGap - 2 * (lines - 1) * lineGap) / (2 * lines) / BoardLayout.ASPECT
            if (c2 >= 8.5f * d) c = min(c, c2)
        }
        cw = c
        ch = cw * BoardLayout.ASPECT
        nameCells = names(cw, oneLine)
    }

    /** Flaps for each club name at cell width [c]. */
    private fun names(c: Float, one: Boolean): Int {
        val scores = 2 * c * 1.5f + 2 * gap + 2 * sectionGap
        val avail = if (one) contentW - scores - 2 * sectionGap - (timeCells + statusCells) * (c + gap) else contentW - scores
        return floor((avail / 2 + gap) / (c + gap)).toInt()
    }

    /** A day's header line ("SATURDAY 31 OCT") above its first match. */
    val dayH get() = 15 * d

    val fontSize get() = ch * 0.82f
    val rowH get() = if (oneLine) ch else ch * 2 + lineGap

    companion object {
        /** Flaps per club name the layout aims for: "MAN UNITED", "SUNDERLAND". */
        const val NAME_TARGET = 10
    }
    val capacity: Int get() = max(1, floor((rowsBottom - rowsTop + rowGap) / (rowH + rowGap)).toInt())

    val statusX get() = w - pad - statusCells * (cw + gap) + gap
    /** Left edge of the scoreline: the home name, right-aligned against its score. */
    val homeX get() = if (oneLine) pad + timeCells * (cw + gap) + sectionGap else pad
    val scoreX get() = homeX + nameCells * (cw + gap) - gap + sectionGap
    val awayScoreX get() = scoreX + scoreW + 2 * gap
    val awayX get() = awayScoreX + scoreW + sectionGap
}

/** Pixel band of one row on the board, for cutting the widget into tappable rows. */
data class Band(val top: Int, val bottom: Int)

class MatchRenderer(private val cornerRadius: Float = 16f) {

    /**
     * Draws [model] and returns the band of each row drawn (from half a gap
     * above it, its day header included, to half a gap below), in order:
     * as many rows as fit. [clock] draws the time in the header; the widget
     * leaves it null and lays a TextClock over that corner.
     */
    fun draw(p: Painter, model: MatchBoardModel, l: MatchLayout, clock: String? = null): List<Band> {
        val d = l.d
        p.rect(0f, 0f, l.w, l.h, Palette.BACKGROUND, cornerRadius * d)

        val hs = 12 * d
        val hb = l.pad + l.headerH / 2 + p.capHeight(hs) / 2
        p.text("MATCHES", l.pad + 2 * d, hb, hs, LABEL, tracking = 0.14f)
        p.text(model.dayLabel, l.pad + 2 * d + p.measure("MATCHES", hs, 0.14f) + 10 * d, hb, hs, Palette.INK, tracking = 0.1f)
        if (clock != null) p.text(clock, l.w - l.pad - 2 * d, hb + d, 15 * d, Palette.RULE, Align.RIGHT, 0.04f)
        p.rect(0f, l.ruleY, l.w, l.ruleH, Palette.RULE)

        val bands = ArrayList<Band>()
        if (model.rows.isEmpty()) {
            drawMessage(p, model.message ?: "NO MATCHES", l)
        } else {
            var y = l.rowsTop
            for ((i, row) in model.rows.withIndex()) {
                val top = y
                // Shorter boards keep the day inside the row instead (see drawRow).
                val header = if (l.dayLines) row.header else null
                val headH = if (header != null) l.dayH else 0f
                if (y + headH + l.rowH > l.rowsBottom + 0.5f && i > 0) break
                if (i > 0) p.rect(l.pad, top - l.rowGap / 2 - d / 2, l.contentW, max(1f, d * 0.75f), Palette.DIVIDER)
                if (header != null) {
                    val size = 10.5f * d
                    p.text(header, l.pad + 1 * d, y + l.dayH / 2 + p.capHeight(size) / 2 - 1.5f * d, size,
                        if (row.pinned) Palette.RULE else LABEL, tracking = 0.12f)
                    y += l.dayH
                }
                drawRow(p, row, y, l)
                bands += Band((top - l.rowGap / 2).toInt(), (y + l.rowH + l.rowGap / 2).toInt())
                y += l.rowH + l.rowGap
            }
        }
        drawFooter(p, model, l, model.more + (model.rows.size - bands.size).coerceAtLeast(0))
        return bands
    }

    private fun drawRow(p: Painter, row: MatchRow, y: Float, l: MatchLayout) {
        val d = l.d
        val m = row.match
        if (row.pinned) {
            // Your club: a lifted row with an amber bar in the margin, and its name in amber.
            p.rect(l.pad - 4 * d, y - 3 * d, l.contentW + 8 * d, l.rowH + 6 * d, PIN_BG, 3 * d)
            p.rect(l.pad - 7 * d, y - 3 * d, 3 * d, l.rowH + 6 * d, Palette.RULE, 1.5f * d)
        }
        val upcomingInk = if (row.section == Section.UPCOMING) Palette.ink(Tone.INFO) else Palette.INK
        val time = if (!l.dayLines && row.section == Section.RECENT) row.dayTime else row.time
        cells(p, time, l.pad, y, l.timeCells, l, if (row.section == Section.RECENT) LABEL else upcomingInk)
        val live = row.status.tone == Tone.LIVE
        val status = if (!l.dayLines && row.status.text.isEmpty()) row.shortDay else row.status.text
        cells(p, status.padEnd(l.statusCells), l.statusX, y, l.statusCells, l, Palette.ink(row.status.tone), live)

        val sy = if (l.oneLine) y else y + l.ch + l.lineGap
        // At full time the winner is bold and the loser dimmed.
        val over = m.status.done
        val homeWon = over && m.winner == Winner.HOME
        val awayWon = over && m.winner == Winner.AWAY
        val n = l.nameCells
        val home = Flap.clean(Clubs.fit(m.home, n)).padStart(n)
        val away = Flap.clean(Clubs.fit(m.away, n)).padEnd(n)
        fun nameInk(t: Team, lost: Boolean) = when {
            lost -> Palette.DIM
            row.pinnedTeam == t.id -> Palette.RULE
            else -> Palette.INK
        }
        cells(p, home, l.homeX, sy, n, l, nameInk(m.home, awayWon), bold = homeWon)
        if (m.homeScore == null && m.awayScore == null && !m.status.live) {
            // No score yet: a small "v" between the names instead of two empty flaps.
            val size = l.fontSize * 0.8f
            val mid = (l.scoreX + l.awayScoreX + l.scoreW) / 2
            p.text("v", mid, sy + l.ch / 2 + p.capHeight(size) / 2, size, LABEL, Align.CENTER)
        } else {
            score(p, m.homeScore, l.scoreX, sy, l, dim = awayWon)
            score(p, m.awayScore, l.awayScoreX, sy, l, dim = homeWon)
        }
        cells(p, away, l.awayX, sy, n, l, nameInk(m.away, homeWon), bold = awayWon)
    }

    /** A club's score on its own amber flap; an empty dark flap when the feed has no score. */
    private fun score(p: Painter, value: Int?, x: Float, y: Float, l: MatchLayout, dim: Boolean) {
        val d = l.d
        val r = 2 * d
        if (value == null) {
            p.rect(x, y, l.scoreW, l.ch, Palette.CELL_TOP, r)
            p.rect(x, y + l.ch / 2, l.scoreW, l.ch / 2, Palette.CELL_BOTTOM, r)
        } else {
            p.rect(x, y, l.scoreW, l.ch, if (dim) AMBER_DIM else Palette.RULE, r)
            val s = value.toString()
            val size = if (s.length > 1) l.fontSize * 0.8f else l.fontSize
            p.text(s, x + l.scoreW / 2, y + l.ch / 2 + p.capHeight(size) / 2, size, if (dim) 0xFF2A2412.toInt() else SCORE_INK, Align.CENTER)
        }
        p.rect(x, y + l.ch / 2 - d * 0.3f, l.scoreW, max(1f, d * 0.6f), Palette.TILE_SPLIT)
    }

    private fun cells(p: Painter, text: String, x: Float, y: Float, n: Int, l: MatchLayout, ink: Int, live: Boolean = false, bold: Boolean = false) {
        val d = l.d
        val top = if (live) Palette.LIVE_TOP else Palette.CELL_TOP
        val bottom = if (live) Palette.LIVE_BOTTOM else Palette.CELL_BOTTOM
        val r = 1.5f * d
        val baseline = y + l.ch / 2 + p.capHeight(l.fontSize) / 2
        for (i in 0 until n) {
            val cx = x + i * (l.cw + l.gap)
            val c = text.getOrNull(i)
            // Blank flaps recede, so the eye goes to the names.
            val blank = (c == null || c == ' ') && !live
            p.rect(cx, y, l.cw, l.ch, if (blank) EMPTY_TOP else top, r)
            p.rect(cx, y + l.ch / 2, l.cw, l.ch / 2, if (blank) EMPTY_BOTTOM else bottom, r)
            p.rect(cx, y + l.ch / 2, l.cw, r, if (blank) EMPTY_BOTTOM else bottom)
            if (c != null && c != ' ') {
                p.text(c.toString(), cx + l.cw / 2, baseline, l.fontSize, ink, Align.CENTER)
                // The flap font has one weight: a second pass a hair to the right makes it bold.
                if (bold) p.text(c.toString(), cx + l.cw / 2 + 0.55f * d, baseline, l.fontSize, ink, Align.CENTER)
            }
            p.rect(cx, y + l.ch / 2 - d * 0.3f, l.cw, max(1f, d * 0.6f), Palette.SPLIT)
        }
    }

    private fun drawMessage(p: Painter, message: String, l: MatchLayout) {
        val n = floor((l.contentW + l.gap) / (l.cw + l.gap)).toInt()
        val lines = BoardRenderer.wrap(Flap.clean(message).trim(), n).take(2)
        val blockH = lines.size * l.ch + (lines.size - 1) * l.lineGap
        val mid = (l.rowsTop + l.rowsBottom) / 2
        lines.forEachIndexed { i, line ->
            val w = line.length * (l.cw + l.gap) - l.gap
            cells(p, line, (l.w - w) / 2, mid - blockH / 2 + i * (l.ch + l.lineGap), line.length, l, Palette.INK)
        }
    }

    private fun drawFooter(p: Painter, model: MatchBoardModel, l: MatchLayout, moreCount: Int) {
        val d = l.d
        val size = 12 * d
        val baseline = l.h - l.pad - (l.footerH - p.capHeight(size)) / 2
        val more = if (moreCount > 0) "+$moreCount MORE" else ""
        val moreW = if (more.isEmpty()) 0f else p.measure(more, size, 0.08f)
        if (more.isNotEmpty()) p.text(more, l.w - l.pad, baseline, size, LABEL, Align.RIGHT, 0.08f)
        val maxW = l.contentW - moreW - if (more.isEmpty()) 0f else 12 * d
        val stale = model.footer.contains("·")
        p.text(BoardRenderer.ellipsize(p, model.footer, size, maxW, 0.08f), l.pad, baseline, size,
            if (stale) Palette.ink(Tone.BOARDING) else LABEL, tracking = 0.08f)
    }

    companion object {
        const val PIN_BG = 0xFF302914.toInt()
        /** Labels on the dark board, brighter than Palette.DIM: the header, day lines and footer. */
        const val LABEL = 0xFFC9C4B5.toInt()
        const val EMPTY_TOP = 0xFF1F1F1F.toInt()
        const val EMPTY_BOTTOM = 0xFF1A1A1A.toInt()
        const val AMBER_DIM = 0xFF6E5A1C.toInt()
        const val SCORE_INK = 0xFF111111.toInt()
    }
}
