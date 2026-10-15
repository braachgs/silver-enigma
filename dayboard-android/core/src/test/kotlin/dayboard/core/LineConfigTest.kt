package dayboard.core

import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class LineConfigTest {
    private val zone = ZoneId.of("Europe/London")
    private fun at(y: Int, m: Int, d: Int, h: Int = 10) = ZonedDateTime.of(y, m, d, h, 0, 0, 0, zone).toInstant().toEpochMilli()

    private val text = listOf(
        "DB1",
        "L\tw1\tWork\tWRK\t0039A6",
        "L\tp1\tPersonal\tPRS\tF2B705",
        "L\ts1\tSocial\tSCL\tB5308E",
        "L\tt1\tTravel\tTRV\tD9262B",
        "A\tMe@Gmail.com\tw1",
        "C\tme@gmail.com\tfamily123@group.calendar.google.com\ts1",
        "E\tabc123\tt1",
        "E\trep9_20261016T040000Z\tt1",
        "F\t2026-10-21\tp1",
    ).joinToString("\n")
    private val cfg = LineConfig.parse(text)!!

    private fun ref(cal: String = "me@gmail.com", id: String? = "x", start: Long = at(2026, 10, 15), allDay: Boolean = false, saved: String? = null, savedName: String? = null) =
        EventRef("me@gmail.com", listOf(cal), id, start, allDay, saved, savedName)

    @Test fun parsesAndRoundTrips() {
        assertEquals(listOf("WRK", "PRS", "SCL", "TRV"), cfg.lines.map { it.code })
        assertEquals(0xFFF2B705.toInt(), cfg.lines[1].color)
        assertEquals(LocalDate.of(2026, 10, 21), cfg.from)
        assertEquals(text.replace("Me@Gmail.com", "me@gmail.com"), LineConfig.parse(cfg.encode())!!.encode())
        assertNull(LineConfig.parse("hello"))
        assertNull(LineConfig.parse("DB1\nA\tx\ty"))
    }

    @Test fun resolvesInTheWebAppsOrder() {
        // Calendar line, then the account's.
        assertEquals("SCL", cfg.resolve(ref(cal = "family123@group.calendar.google.com"), at(2026, 10, 15), zone)!!.code)
        assertEquals("WRK", cfg.resolve(ref(), at(2026, 10, 15), zone)!!.code)
        // A line picked for one event wins over everything; a repeating event matches by instance id.
        assertEquals("TRV", cfg.resolve(ref(id = "abc123"), at(2026, 10, 25), zone)!!.code)
        assertEquals("TRV", cfg.resolve(ref(id = "rep9", start = at(2026, 10, 16, 5)), at(2026, 10, 16, 5), zone)!!.code)
        assertEquals("WRK", cfg.resolve(ref(id = "rep9", start = at(2026, 10, 17, 5)), at(2026, 10, 17, 5), zone)!!.code)
        // A line Day Board saved on the event, by id or by name.
        assertEquals("SCL", cfg.resolve(ref(saved = "s1"), at(2026, 10, 25), zone)!!.code)
        assertEquals("TRV", cfg.resolve(ref(savedName = "travel"), at(2026, 10, 15), zone)!!.code)
    }

    @Test fun personalFromTheTwentyFirst() {
        val fam = "family123@group.calendar.google.com"
        assertEquals("SCL", cfg.resolve(ref(cal = fam), at(2026, 10, 20, 23), zone)!!.code)
        assertEquals("PRS", cfg.resolve(ref(cal = fam), at(2026, 10, 21, 0), zone)!!.code)
        assertEquals("PRS", cfg.resolve(ref(), at(2026, 12, 1), zone)!!.code)
    }

    @Test fun unknownAccountsKeepTheCalendarLook() {
        assertNull(cfg.resolve(EventRef("work@corp.com", listOf("work@corp.com"), "x", 0, false), at(2026, 10, 25), zone))
    }
}
