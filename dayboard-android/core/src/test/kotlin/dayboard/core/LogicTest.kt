package dayboard.core

import dayboard.core.Samples.LONDON
import dayboard.core.Samples.t
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class LogicTest {
    @Test fun flapCodesMatchTheWebApp() {
        assertEquals("WRK", Flap.code("Work"))
        assertEquals("PRS", Flap.code("Personal"))
        assertEquals("BOB", Flap.code("Bob"))
        assertEquals("EAT", Flap.code("Eat"))
        assertEquals("BRN", Flap.code("Brentford FC"))
        assertEquals("GGN", Flap.code("Gagne Family"))
        assertEquals("CAF", Flap.code("Café"))
        assertEquals("会議室", Flap.code("会議 室"))
        assertEquals("LN", Flap.code(""))
    }

    @Test fun flapTextIsCleanedAndCut() {
        assertEquals("CAFE - JOSE'S", Flap.clean("Café – José’s"))
        assertEquals("DESIGN REVIEW…", Flap.fit("Design review with Priya", 15)) // cut at a word, as js/flap.js does
        assertTrue(Flap.legible("Brentford v Leeds"))
        assertTrue(!Flap.legible("Встреча с командой"))
    }

    @Test fun remarksChangeExactlyAtTheirBoundaries() {
        val start = t("2026-10-15T10:00+01:00[Europe/London]")
        val end = start + 30 * MINUTE
        assertEquals(Remarks.ON_TIME, Remarks.of(start, end, start - 15 * MINUTE - 1))
        assertEquals(Remarks.BOARDING, Remarks.of(start, end, start - 15 * MINUTE))
        assertEquals(Remarks.BOARDING, Remarks.of(start, end, start - 2 * MINUTE - 1))
        assertEquals(Remarks.FINAL_CALL, Remarks.of(start, end, start - 2 * MINUTE))
        assertEquals(Remarks.NOW, Remarks.of(start, end, start))
        assertEquals(Remarks.DEPARTED, Remarks.of(start, end, end))
        assertEquals(start - 15 * MINUTE, Remarks.nextChange(start, end, start - 60 * MINUTE))
        assertEquals(start - 2 * MINUTE, Remarks.nextChange(start, end, start - 15 * MINUTE))
        assertEquals(end, Remarks.nextChange(start, end, start))
        assertNull(Remarks.nextChange(start, end, end))
    }

    @Test fun boardShowsLiveThenUpcomingThenTomorrow() {
        val b = BoardBuilder(LONDON, hour12 = true, Locale.UK)
        val now = t("2026-10-15T09:52+01:00[Europe/London]")
        val m = b.build(Samples.day(), Samples.lineOf, now, maxRows = 8)
        assertEquals("THU 15 OCT", m.dayLabel)
        assertEquals(listOf("NOW", "BOARDING", "ON TIME", "ON TIME", "ON TIME", "TOMORROW", "TOMORROW"), m.rows.map { it.remark.text })
        assertEquals(listOf(" 9:30A", "10:05A", "11:30A", " 6:00P", " 8:30P", " 8:30A", "10:00A"), m.rows.map { it.time })
        assertEquals(listOf("WRK", "WRK", "PRS", "GGN", "BRN", "PRS", "WRK"), m.rows.map { it.line.code })
        assertEquals(listOf("Half term"), m.allDay.map { it.title })
        assertEquals(0, m.moreToday)
        assertNull(m.message)
        // Next wake-up: standup ends at 10:00, Design review hits FINAL CALL at 10:03... the earliest is 10:00.
        assertEquals(t("2026-10-15T10:00+01:00[Europe/London]"), m.nextChange)
    }

    @Test fun twentyFourHourTimesAndOverflow() {
        val b = BoardBuilder(LONDON, hour12 = false, Locale.UK)
        val m = b.build(Samples.day(), Samples.lineOf, t("2026-10-15T09:52+01:00[Europe/London]"), maxRows = 2)
        assertEquals(listOf("09:30", "10:05"), m.rows.map { it.time })
        assertEquals(3, m.moreToday)
    }

    @Test fun eveningAndEmptyBoards() {
        val b = BoardBuilder(LONDON, hour12 = true, Locale.UK)
        val late = b.build(Samples.day().filter { !it.allDay && it.start < t("2026-10-16T00:00+01:00[Europe/London]") }, Samples.lineOf,
            t("2026-10-15T23:00+01:00[Europe/London]"), maxRows = 3)
        assertTrue(late.rows.isEmpty())
        assertEquals("NO MORE DEPARTURES TODAY", late.message)
        assertEquals(t("2026-10-16T00:00+01:00[Europe/London]"), late.nextChange)
        val blocked = b.build(Samples.day(), Samples.lineOf, t("2026-10-15T09:52+01:00[Europe/London]"), 3, message = "ALLOW CALENDAR ACCESS")
        assertTrue(blocked.rows.isEmpty())
        assertEquals("ALLOW CALENDAR ACCESS", blocked.message)
    }

    @Test fun midnightAndClockChangeDays() {
        val b = BoardBuilder(LONDON, hour12 = true, Locale.UK)
        // 25 Oct 2026 is 25 hours long in London; the day still starts at local midnight.
        assertEquals(t("2026-10-25T00:00+01:00[Europe/London]"), b.dayStart(t("2026-10-25T23:30Z[UTC]") - 60 * MINUTE))
        assertEquals(t("2026-10-26T00:00Z[UTC]"), b.dayStart(t("2026-10-25T12:00Z[UTC]"), 1))
        assertEquals(" 1:30A", b.boardTime(t("2026-10-25T01:30Z[UTC]")))
    }

    @Test fun layoutsFitCommonWidgetSizes() {
        // (width, height) in dp: 3x2, 4x2, 4x3, 5x2, 4x4 on a typical phone.
        for ((wDp, hDp) in listOf(230 to 150, 300 to 150, 300 to 230, 390 to 150, 300 to 310)) {
            for (hour12 in listOf(true, false)) {
                val d = 2.75f
                val l = BoardLayout(wDp * d, hDp * d, d, hour12)
                val timeEnd = l.timeX + l.timeCells * (l.cw + l.gap)
                assertTrue(timeEnd + l.sectionGap <= l.remarkX + 0.5f, "time and remark overlap at ${wDp}x$hDp")
                val titleEnd = l.titleX + l.titleCells * (l.cw + l.gap) - l.gap
                val limit = if (l.oneLine) l.remarkX - l.sectionGap else l.w - l.pad
                assertTrue(titleEnd <= limit + 0.5f, "title runs past its space at ${wDp}x$hDp")
                assertTrue(l.titleCells >= 12, "too few title cells (${l.titleCells}) at ${wDp}x$hDp")
                if (hDp >= 150) assertTrue(l.capacity >= 2, "only ${l.capacity} row at ${wDp}x$hDp")
                assertTrue(l.rowsTop + l.capacity * l.rowH + (l.capacity - 1) * l.rowGap <= l.rowsBottom + 0.5f || l.capacity == 1,
                    "rows overflow at ${wDp}x$hDp")
            }
        }
    }
}
