package dayboard.match

import dayboard.core.Align
import dayboard.core.AwtPainter
import dayboard.core.Painter
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import javax.imageio.ImageIO
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MatchTest {
    private val london = ZoneId.of("Europe/London")
    private fun t(s: String) = Instant.parse(s).toEpochMilli()
    private val json = MatchTest::class.java.getResource("/pl-matches.json")!!.readText()
    private val matches = FootballData.parseMatches(json)
    private val builder = MatchBoardBuilder(london, Locale.UK)
    private val brentford = 402
    // Sunday 25 Oct 2026, 2:40 PM in London (the clocks went back at 2 AM).
    private val now = t("2026-10-25T14:40:00Z")

    @Test fun parsesV4() {
        assertEquals(10, matches.size)
        val bre = matches.first { it.id == 1005L }
        assertEquals(MatchStatus.IN_PLAY, bre.status)
        assertEquals("Brentford" to "Man United", bre.home.shortName to bre.away.shortName)
        assertEquals(1 to 1, bre.homeScore to bre.awayScore)
        val che = matches.first { it.id == 1007L }
        assertNull(che.homeScore) // no score until the feed gives one
        assertEquals(Winner.AWAY, matches.first { it.id == 1004L }.winner)
        assertEquals(MatchStatus.IN_PLAY, MatchStatus.of("LIVE"))
        assertEquals(MatchStatus.UNKNOWN, MatchStatus.of("SOMETHING_NEW"))
        assertEquals(18, FootballData.parseTeams(MatchTest::class.java.getResource("/pl-teams.json")!!.readText()).size)
        assertEquals("Your API token is invalid.", FootballData.errorMessage("""{"message":"Your API token is invalid.","errorCode":400}"""))
    }

    @Test fun jsonReader() {
        val v = Json.parse("""{"a":"q\"\\\u00e9\n","b":[1,-2.5e1,true,null],"c":{}}""").obj()!!
        assertEquals("q\"\\é\n", v["a"])
        assertEquals(listOf(1.0, -25.0, true, null), v["b"])
    }

    @Test fun ordersTodayUpcomingRecentWithYourClubOnTop() {
        val rows = builder.order(matches, brentford, now)
        assertEquals(listOf(1005L, 1006, 1007, 1008, 1009, 1010, 1004, 1002, 1003, 1001), rows.map { it.match.id })
        assertTrue(rows[0].pinned && rows.drop(1).none { it.pinned })
        // Later days' fixtures have nothing to report: the day line above them says when.
        assertEquals(listOf("LIVE", "IN 20 MIN", "ON TIME", "", "", "", "FULL TIME", "FULL TIME", "POSTPONED", "FULL TIME"),
            rows.map { it.status.text })
        assertEquals(listOf(" 2:00P", " 3:00P", " 4:30P", " 8:00P", " 3:00P", " 2:00P", " 5:30P", " 3:00P", " 3:00P", "12:30P"), rows.map { it.time })
        assertEquals(listOf("YOUR CLUB · TODAY", "TODAY", null, "TOMORROW", "SATURDAY 31 OCT", "SUNDAY 1 NOV", "YESTERDAY", null, null, null),
            rows.map { it.header })
        assertEquals(brentford, rows[0].pinnedTeam)
        // Short boards (a 4x2 widget) keep the day in the row instead.
        assertEquals(listOf("", "", "", "TOMORROW", "SAT 31 OCT", "SUN 1 NOV"), rows.take(6).map { it.shortDay })
        assertEquals("SAT 24", rows[6].dayTime)
    }

    @Test fun pinsTheNextMatchWhenNoneIsLive() {
        val done = matches.map { if (it.id == 1005L) it.copy(status = MatchStatus.FINISHED, winner = Winner.DRAW) else it }
        val rows = builder.order(done, brentford, now)
        assertEquals(1010L, rows[0].match.id)
        assertTrue(rows[0].pinned)
        assertEquals("", rows[0].status.text)
        assertEquals("YOUR CLUB · SUNDAY 1 NOV", rows[0].header)
        assertEquals(1005L, rows[1].match.id) // today's result stays in today's list
        assertNull(builder.pinned(done, null, now))
    }

    @Test fun onADayWithoutMatchesResultsComeFirst() {
        // Tuesday 27 Oct: no matches today, so the weekend's results lead, then the fixtures.
        val tue = t("2026-10-27T09:00:00Z")
        val rows = builder.order(matches, brentford, tue)
        assertEquals(listOf(1010L, 1008, 1007, 1006, 1005, 1004, 1002, 1003, 1001, 1009), rows.map { it.match.id })
        assertEquals(listOf("YOUR CLUB · SUNDAY 1 NOV", "YESTERDAY", "SUNDAY 25 OCT", null, null, "SATURDAY 24 OCT", null, null, null, "SATURDAY 31 OCT"),
            rows.map { it.header })
    }

    @Test fun statusesNeverClaimMoreThanTheFeedSays() {
        val half = matches.first { it.id == 1005L }.copy(status = MatchStatus.PAUSED)
        assertEquals("HALF TIME", builder.status(half, now).text)
        // Past kickoff, but the feed still says TIMED: not LIVE, and no score.
        val liv = matches.first { it.id == 1006L }
        assertEquals("KICK OFF", builder.status(liv, t("2026-10-25T15:02:00Z")).text)
        assertEquals("IN 5 MIN", builder.status(liv, t("2026-10-25T14:57:30Z")).text)
        assertEquals("IN 60 MIN", builder.status(liv, t("2026-10-25T14:00:00Z")).text)
        assertEquals("ON TIME", builder.status(liv, t("2026-10-25T13:59:00Z")).text)
    }

    @Test fun nextChangeIsTheNextCountdownStep() {
        assertEquals(t("2026-10-25T14:45:00Z"), builder.nextChange(matches, now))
        assertEquals(t("2026-10-25T15:00:00Z"), builder.nextChange(matches, t("2026-10-25T14:56:00Z")))
        assertEquals(t("2026-10-25T15:30:00Z"), builder.nextChange(matches, t("2026-10-25T15:01:00Z")))
        assertEquals(t("2026-10-26T00:00:00Z"), builder.nextChange(matches, t("2026-10-25T17:00:00Z")))
    }

    @Test fun staleDataKeepsTheLastScoreAndSaysHowOld() {
        val fetched = t("2026-10-25T14:39:00Z")
        val fresh = builder.build(FeedState(matches, fetched), brentford, now, 4)
        assertEquals("AS OF 2:39 PM", fresh.footer)
        val later = t("2026-10-25T15:20:00Z")
        val stale = builder.build(FeedState(matches, fetched, error = "UPDATE FAILED"), brentford, later, 4)
        assertEquals("AS OF 2:39 PM · UPDATE FAILED", stale.footer)
        val bre = stale.rows.first().match
        assertEquals(1 to 1, bre.homeScore to bre.awayScore)
        assertEquals("LIVE", stale.rows.first().status.text) // as last reported
        assertEquals(6, stale.more)
        assertEquals("AS OF SAT 7:10 PM · OFFLINE", builder.build(FeedState(matches, t("2026-10-24T18:10:00Z"), error = "OFFLINE"), brentford, now, 4).footer)
        assertEquals("ADD YOUR API KEY IN MATCH BOARD", builder.build(FeedState(emptyList(), null, message = "ADD YOUR API KEY IN MATCH BOARD"), brentford, now, 4).message)
        assertEquals("CHECK API KEY", builder.build(FeedState(emptyList(), null, error = "CHECK API KEY"), brentford, now, 4).message)
        assertEquals("NO PREMIER LEAGUE MATCHES THIS WEEK", builder.build(FeedState(emptyList(), fetched), brentford, now, 4).message)
    }

    @Test fun clubNames() {
        val teams = matches.flatMap { listOf(it.home, it.away) }.associateBy { it.tla }
        assertEquals("Brighton", Clubs.name(teams["BHA"]!!))
        assertEquals("Wolves", Clubs.name(teams["WOL"]!!))
        assertEquals("Man United", Clubs.fit(teams["MUN"]!!, 10))
        assertEquals("Man Utd", Clubs.fit(teams["MUN"]!!, 8))
        assertEquals("Palace", Clubs.fit(teams["CRY"]!!, 11))
        assertEquals("Forest", Clubs.fit(teams["NOT"]!!, 9))
        assertEquals("AVL", Clubs.fit(teams["AVL"]!!, 3))
        // Clubs no list knows lose a generic last word before falling back to their code.
        val cov = Team(1076, "Coventry City FC", "Coventry City", "COV")
        assertEquals("Coventry", Clubs.fit(cov, 11))
        val hull = Team(322, "Hull City AFC", "Hull City", "HUL")
        assertEquals("Hull City", Clubs.fit(hull, 11))
        assertEquals("Hull", Clubs.fit(hull, 8))
        assertEquals("West Ham", Clubs.fit(teams["WHU"]!!, 8))
        assertEquals("WHU", Clubs.fit(teams["WHU"]!!, 7)) // never just the first word
    }

    /** Records how far drawing reaches, to catch anything spilling off the board. */
    private class Bounds(val inner: Painter) : Painter by inner {
        var maxX = 0f; var maxY = 0f
        override fun rect(x: Float, y: Float, w: Float, h: Float, color: Int, radius: Float) {
            maxX = maxOf(maxX, x + w); maxY = maxOf(maxY, y + h); inner.rect(x, y, w, h, color, radius)
        }
        override fun text(s: String, x: Float, baseline: Float, size: Float, color: Int, align: Align, tracking: Float) {
            val w = inner.measure(s, size, tracking)
            maxX = maxOf(maxX, when (align) { Align.LEFT -> x + w; Align.CENTER -> x + w / 2; Align.RIGHT -> x })
            inner.text(s, x, baseline, size, color, align, tracking)
        }
    }

    private val out = File(System.getProperty("previews.dir") ?: "build/previews").apply { mkdirs() }

    private fun preview(name: String, wDp: Int, hDp: Int, state: FeedState = FeedState(matches, t("2026-10-25T14:39:00Z")), at: Long = now): List<Band> {
        val d = 3f
        val l = MatchLayout(wDp * d, hDp * d, d)
        val model = builder.build(state, brentford, at, l.capacity)
        var bands = emptyList<Band>()
        var spill = 0f
        val img = AwtPainter.image(l.w.toInt(), l.h.toInt()) { p ->
            val b = Bounds(p)
            bands = MatchRenderer().draw(b, model, l, clock = "2:40")
            spill = b.maxX - l.w
        }
        ImageIO.write(img, "png", File(out, "match-$name.png"))
        assertTrue(spill <= 0.5f, "$name: drawing spills ${spill}px past the right edge")
        // As many rows as fit (day lines take room); the rest count in "+N MORE".
        assertTrue(bands.size <= model.rows.size && (model.rows.isEmpty() || bands.isNotEmpty()), "$name: ${bands.size} of ${model.rows.size} rows drawn")
        bands.zipWithNext().forEach { (a, b) -> assertEquals(a.bottom, b.top, "$name: rows tile without gaps") }
        bands.lastOrNull()?.let { assertTrue(it.bottom <= l.h, "$name: rows end on the board") }
        return bands
    }

    @Test fun previews() {
        assertEquals(2, preview("4x2", 300, 150).size)
        val b43 = preview("4x3", 300, 230).size; assertTrue(b43 >= 3, "4x3 shows $b43 rows")
        preview("4x4", 300, 310)
        preview("5x2", 390, 150)
        preview("3x2", 230, 150)
        preview("phone-5x3", 380, 320)
        preview("wide-6x3", 520, 230)
        val done = matches.map { if (it.id == 1005L) it.copy(status = MatchStatus.FINISHED, homeScore = 2, awayScore = 1, winner = Winner.HOME) else it }
        preview("4x3-full-time", 300, 230, FeedState(done, t("2026-10-25T16:01:00Z")), t("2026-10-25T16:05:00Z"))
        preview("4x2-stale", 300, 150, FeedState(matches, t("2026-10-25T14:39:00Z"), error = "UPDATE FAILED"), t("2026-10-25T15:20:00Z"))
        preview("4x2-no-key", 300, 150, FeedState(emptyList(), null, message = "ADD YOUR API KEY IN MATCH BOARD"))
        preview("4x3-tuesday", 300, 230, at = t("2026-10-27T09:00:00Z"))
        assertTrue(preview("4x2-tuesday", 300, 150, at = t("2026-10-27T09:00:00Z")).size == 2, "a 4x2 widget still shows two matches")
        preview("edge-vm", 360, 435)
        preview("edge-vm-tuesday", 360, 435, at = t("2026-10-27T09:00:00Z"))
    }
}
