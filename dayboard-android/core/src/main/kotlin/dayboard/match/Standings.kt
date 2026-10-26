package dayboard.match

import dayboard.core.Align
import dayboard.core.BoardLayout
import dayboard.core.Flap
import dayboard.core.Painter
import dayboard.core.Palette
import dayboard.core.Tone
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** One club's line in a league table. */
data class Standing(
    val position: Int,
    val team: Team,
    val played: Int,
    val won: Int,
    val draw: Int,
    val lost: Int,
    val goalDifference: Int,
    val points: Int,
)

/** Where a place in the table leads, Championship style: up, play-offs, down. */
enum class Zone { PROMOTED, PLAYOFF, RELEGATED, NONE }

data class TableRow(val standing: Standing, val zone: Zone, val favourite: Boolean)

/** The last table fetched successfully, and how the latest attempt went (as [FeedState]). */
data class TableState(
    val table: List<Standing>,
    val fetchedAt: Long?,
    val error: String? = null,
    val message: String? = null,
)

data class TableModel(
    /** The rows to show, in table order: all of them, or a run around your club. */
    val rows: List<TableRow>,
    val total: Int,
    val message: String?,
    /** "AS OF 3:05 PM", plus why the data may be old. */
    val footer: String,
    val stale: Boolean,
    /** "WREXHAM 7TH", for the footer's right. */
    val favouriteLine: String,
)

object Standings {
    /** The overall ("TOTAL") table from a /competitions/{code}/standings response. */
    fun parse(json: String): List<Standing> {
        val groups = Json.parse(json).obj()?.get("standings").list().mapNotNull { it.obj() }
        val total = groups.firstOrNull { it.str("type") == "TOTAL" } ?: groups.firstOrNull() ?: return emptyList()
        return total["table"].list().mapNotNull { r ->
            val o = r.obj() ?: return@mapNotNull null
            val team = FootballData.parseTeam(o["team"].obj()) ?: return@mapNotNull null
            Standing(
                position = o.int("position") ?: return@mapNotNull null,
                team = team,
                played = o.int("playedGames") ?: 0,
                won = o.int("won") ?: 0,
                draw = o.int("draw") ?: 0,
                lost = o.int("lost") ?: 0,
                goalDifference = o.int("goalDifference") ?: 0,
                points = o.int("points") ?: 0,
            )
        }.sortedBy { it.position }
    }

    /** The Championship's places: 1-2 promoted, 3-6 play-offs, the bottom three relegated (24 clubs). */
    fun zone(position: Int, size: Int): Zone = when {
        size != 24 -> Zone.NONE
        position <= 2 -> Zone.PROMOTED
        position <= 6 -> Zone.PLAYOFF
        position > size - 3 -> Zone.RELEGATED
        else -> Zone.NONE
    }

    /** The club whose name, short name or code matches [text] ("Wrexham", "WRE"). */
    fun find(table: List<Standing>, text: String): Standing? {
        val q = text.trim().lowercase(Locale.ROOT)
        if (q.isEmpty()) return null
        return table.firstOrNull { s -> listOf(s.team.name, s.team.shortName, s.team.tla, Clubs.name(s.team)).any { it.lowercase(Locale.ROOT) == q } }
            ?: table.firstOrNull { it.team.name.lowercase(Locale.ROOT).contains(q) || Clubs.name(it.team).lowercase(Locale.ROOT).contains(q) }
    }

    fun ordinal(n: Int): String = n.toString() + when {
        n % 100 in 11..13 -> "TH"
        n % 10 == 1 -> "ST"
        n % 10 == 2 -> "ND"
        n % 10 == 3 -> "RD"
        else -> "TH"
    }

    /**
     * The rows that fit in [capacity]: the whole table if it fits, else a run
     * of it centred on your club (so you always see who's around you).
     */
    fun build(state: TableState, favourite: String, now: Long, zone: ZoneId, capacity: Int): TableModel {
        val table = state.table
        val fav = find(table, favourite)
        val message = state.message ?: when {
            state.fetchedAt == null && state.error != null -> state.error
            state.fetchedAt == null -> "WAITING FOR THE FIRST UPDATE"
            table.isEmpty() -> "NO TABLE YET"
            else -> null
        }
        val cap = capacity.coerceAtLeast(1)
        val start = if (table.size <= cap || fav == null) 0
        else (table.indexOf(fav) - cap / 2).coerceIn(0, table.size - cap)
        val rows = if (message != null) emptyList() else table.drop(start).take(cap).map {
            TableRow(it, zone(it.position, table.size), it == fav)
        }
        val asOf = state.fetchedAt?.let {
            val z = Instant.ofEpochMilli(it).atZone(zone)
            val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
            val dayPart = if (z.toLocalDate() == today) "" else DateTimeFormatter.ofPattern("EEE", Locale.UK).format(z).uppercase() + " "
            "AS OF " + dayPart + DateTimeFormatter.ofPattern("h:mm a", Locale.UK).format(z).uppercase()
        }
        val parts = listOfNotNull(asOf, state.error?.takeIf { state.fetchedAt != null })
        return TableModel(
            rows = rows,
            total = table.size,
            message = message,
            footer = parts.joinToString(" · "),
            stale = parts.size > 1,
            favouriteLine = fav?.let { Flap.clean(Clubs.name(it.team)).trim() + " " + ordinal(it.position) } ?: "",
        )
    }
}

/**
 * A league table on a flap board: one line per club, POS CLUB P GD PTS,
 * with a plain column header line. Sized like the match layout's frame.
 */
class TableLayout(override val w: Float, override val h: Float, override val d: Float) : FlapFrame {
    private val compact = h < 190 * d
    override val pad = (if (compact) 8 else 10) * d
    override val headerH = (if (compact) 20 else 24) * d
    override val ruleY = pad + headerH
    override val ruleH = 2 * d
    override val gap = max(1f, 1f * d)
    val sectionGap = 6 * d
    override val contentW = w - 2 * pad
    override val lineGap = 3 * d
    val rowGap = (if (compact) 3 else 4) * d
    val colHeadH = 13 * d
    override val rowsTop = ruleY + ruleH + (if (compact) 4 else 6) * d
    override val footerH = (if (compact) 14 else 16) * d
    override val rowsBottom = h - pad - footerH

    val posCells = 2
    val playedCells = 2
    val gdCells = 3
    val ptsCells = 3
    override val cw: Float
    override val ch: Float
    val nameCells: Int

    init {
        // Aim for 12-flap names ("SHEFFIELD WED"), as big as fits, no bigger than the match board's.
        val fixed = posCells + playedCells + gdCells + ptsCells
        val target = 12
        val c = (contentW - 4 * sectionGap - (fixed + target) * gap) / (fixed + target)
        cw = min(12 * d, max(6.5f * d, c))
        ch = cw * BoardLayout.ASPECT
        nameCells = floor((contentW - 4 * sectionGap - fixed * (cw + gap) + gap) / (cw + gap)).toInt()
    }

    override val fontSize get() = ch * 0.82f
    val rowH get() = ch
    val firstRowTop get() = rowsTop + colHeadH
    val capacity get() = max(1, floor((rowsBottom - firstRowTop + rowGap) / (rowH + rowGap)).toInt())

    val posX get() = pad
    val nameX get() = posX + posCells * (cw + gap) + sectionGap
    val ptsX get() = w - pad - ptsCells * (cw + gap) + gap
    val gdX get() = ptsX - sectionGap - gdCells * (cw + gap)
    val playedX get() = gdX - sectionGap - playedCells * (cw + gap)
}

class TableRenderer(private val match: MatchRenderer) {
    /** Draws the table under the tabbed header; returns the band holding the rows (for one tap target). */
    fun draw(p: Painter, model: TableModel, l: TableLayout, tabs: List<String>, active: Int, clock: String? = null): Band? {
        val d = l.d
        match.header(p, l, tabs, active, null, clock)
        if (model.rows.isEmpty()) {
            match.drawMessage(p, model.message ?: "NO TABLE YET", l)
            match.footer(p, l, model.footer, model.favouriteLine, model.stale)
            return null
        }
        // Column labels, plain text over their columns.
        val size = 10.5f * d
        val lb = l.rowsTop + l.colHeadH / 2 + p.capHeight(size) / 2 - d
        val lab = MatchRenderer.LABEL
        p.text("POS", l.posX + l.posCells * (l.cw + l.gap) / 2, lb, size, lab, Align.CENTER, 0.1f)
        p.text("CLUB", l.nameX, lb, size, lab, tracking = 0.1f)
        p.text("P", l.playedX + l.playedCells * (l.cw + l.gap) / 2, lb, size, lab, Align.CENTER, 0.1f)
        p.text("GD", l.gdX + l.gdCells * (l.cw + l.gap) / 2, lb, size, lab, Align.CENTER, 0.1f)
        p.text("PTS", l.ptsX + l.ptsCells * (l.cw + l.gap) / 2, lb, size, lab, Align.CENTER, 0.1f)

        var y = l.firstRowTop
        var last: TableRow? = null
        for (row in model.rows) {
            val s = row.standing
            // A thin line where a zone ends: under 2nd, 6th and 21st.
            if (last != null && last.zone != row.zone) p.rect(l.pad, y - l.rowGap / 2 - d / 2, l.contentW, max(1f, d * 0.75f), ZONE_LINE)
            if (row.favourite) {
                p.rect(l.pad - 4 * d, y - 2 * d, l.contentW + 8 * d, l.rowH + 4 * d, MatchRenderer.PIN_BG, 3 * d)
            }
            zoneColor(row.zone)?.let { p.rect(l.pad - 7 * d, y, 3 * d, l.rowH, it, 1.5f * d) }
            if (row.favourite) p.rect(l.pad - 7 * d, y - 2 * d, 3 * d, l.rowH + 4 * d, Palette.RULE, 1.5f * d)
            val nameInk = if (row.favourite) Palette.RULE else Palette.INK
            match.cells(p, s.position.toString().padStart(l.posCells), l.posX, y, l.posCells, l, MatchRenderer.LABEL)
            match.cells(p, Flap.clean(Clubs.fit(s.team, l.nameCells)).padEnd(l.nameCells), l.nameX, y, l.nameCells, l, nameInk)
            match.cells(p, s.played.toString().padStart(l.playedCells), l.playedX, y, l.playedCells, l, Palette.ink(Tone.INFO))
            val gd = when { s.goalDifference > 0 -> "+${s.goalDifference}"; else -> s.goalDifference.toString() }
            match.cells(p, gd.padStart(l.gdCells), l.gdX, y, l.gdCells, l, Palette.ink(Tone.INFO))
            match.cells(p, s.points.toString().padStart(l.ptsCells), l.ptsX, y, l.ptsCells, l, Palette.RULE)
            y += l.rowH + l.rowGap
            last = row
        }
        val more = model.total - model.rows.size
        match.footer(p, l, model.footer, model.favouriteLine.ifEmpty { if (more > 0) "+$more MORE" else "" }, model.stale)
        return Band(l.rowsTop.toInt(), (y - l.rowGap / 2).toInt().coerceAtMost(l.h.toInt()))
    }

    companion object {
        const val ZONE_LINE = 0xFF3A3A3A.toInt()
        fun zoneColor(z: Zone): Int? = when (z) {
            Zone.PROMOTED -> 0xFF2E8540.toInt()
            Zone.PLAYOFF -> 0xFF93DD73.toInt()
            Zone.RELEGATED -> 0xFFC8102E.toInt()
            Zone.NONE -> null
        }
    }
}
