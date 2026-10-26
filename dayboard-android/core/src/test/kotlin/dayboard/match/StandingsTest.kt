package dayboard.match

import dayboard.core.AwtPainter
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import javax.imageio.ImageIO
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class StandingsTest {
    private val london = ZoneId.of("Europe/London")
    private fun t(s: String) = Instant.parse(s).toEpochMilli()
    private val table = Standings.parse(StandingsTest::class.java.getResource("/elc-standings.json")!!.readText())
    private val now = t("2026-10-26T08:11:00Z")
    private val tabs = listOf("MATCHES", "CHAMPIONSHIP")

    @Test fun parsesTheOverallTable() {
        assertEquals(24, table.size)
        assertEquals(listOf(1, 2, 3), table.take(3).map { it.position }) // TOTAL, not HOME/AWAY
        val wre = Standings.find(table, "Wrexham")!!
        assertEquals(9 to 22, wre.position to wre.points)
        assertEquals(wre, Standings.find(table, "WRE"))
        assertNull(Standings.find(table, "Real Madrid"))
    }

    @Test fun zonesAndOrdinals() {
        assertEquals(listOf(Zone.PROMOTED, Zone.PROMOTED, Zone.PLAYOFF, Zone.PLAYOFF, Zone.PLAYOFF, Zone.PLAYOFF, Zone.NONE),
            (1..7).map { Standings.zone(it, 24) })
        assertEquals(listOf(Zone.NONE, Zone.RELEGATED, Zone.RELEGATED, Zone.RELEGATED), (21..24).map { Standings.zone(it, 24) })
        assertEquals(listOf("1ST", "2ND", "3RD", "9TH", "11TH", "12TH", "21ST", "22ND"), listOf(1, 2, 3, 9, 11, 12, 21, 22).map { Standings.ordinal(it) })
    }

    @Test fun showsTheRunAroundYourClubWhenTheTableDoesntFit() {
        val m = Standings.build(TableState(table, now), "Wrexham", now, london, 7)
        assertEquals((6..12).toList(), m.rows.map { it.standing.position })
        assertTrue(m.rows.single { it.favourite }.standing.team.shortName == "Wrexham")
        assertEquals("WREXHAM 9TH", m.favouriteLine)
        assertEquals("AS OF 8:11 AM", m.footer)
        assertEquals(24, Standings.build(TableState(table, now), "Wrexham", now, london, 30).rows.size)
        // Top of the table: the run doesn't go above 1st.
        assertEquals((1..5).toList(), Standings.build(TableState(table, now), "Leicester", now, london, 5).rows.map { it.standing.position })
        val stale = Standings.build(TableState(table, now, error = "OFFLINE OR BLOCKED"), "Wrexham", t("2026-10-26T12:00:00Z"), london, 7)
        assertTrue(stale.stale && stale.footer == "AS OF 8:11 AM · OFFLINE OR BLOCKED")
        assertEquals("CHECK API KEY", Standings.build(TableState(emptyList(), null, error = "CHECK API KEY"), "Wrexham", now, london, 7).message)
    }

    private val out = File(System.getProperty("previews.dir") ?: "build/previews").apply { mkdirs() }

    private fun preview(name: String, wDp: Int, hDp: Int, fav: String = "Wrexham"): Pair<Band?, Int> {
        val d = 3f
        val l = TableLayout(wDp * d, hDp * d, d)
        val model = Standings.build(TableState(table, t("2026-10-26T08:10:00Z")), fav, now, london, l.capacity)
        var band: Band? = null
        val match = MatchRenderer()
        val img = AwtPainter.image(l.w.toInt(), l.h.toInt()) { p -> band = TableRenderer(match).draw(p, model, l, tabs, 1, clock = "8:11") }
        ImageIO.write(img, "png", File(out, "table-$name.png"))
        assertEquals(2, match.tabHits.size, "$name: both tabs have tap zones")
        assertTrue(match.tabHits[0].second <= match.tabHits[1].first, "$name: tab zones don't overlap")
        return band to model.rows.size
    }

    @Test fun previews() {
        val (b42, n42) = preview("4x2", 300, 150)
        assertNotNull(b42)
        assertTrue(n42 >= 3, "a 4x2 widget shows at least 3 clubs ($n42)")
        assertTrue(preview("4x3", 300, 230).second >= 6)
        preview("4x4", 300, 310)
        preview("edge-vm", 360, 435)
        preview("edge-vl", 360, 875)
        preview("5x2", 390, 150)

        // The match board with tabs, for comparison.
        val d = 3f
        val l = MatchLayout(300 * d, 230 * d, d)
        val matches = FootballData.parseMatches(StandingsTest::class.java.getResource("/pl-matches.json")!!.readText())
        val model = MatchBoardBuilder(london, Locale.UK).build(FeedState(matches, t("2026-10-25T14:39:00Z")), 402, t("2026-10-25T14:40:00Z"), l.capacity)
        val r = MatchRenderer()
        val img = AwtPainter.image(l.w.toInt(), l.h.toInt()) { p -> r.draw(p, model, l, clock = "2:40", tabs = tabs) }
        ImageIO.write(img, "png", File(out, "match-4x3-tabs.png"))
        assertEquals(2, r.tabHits.size)
    }
}
