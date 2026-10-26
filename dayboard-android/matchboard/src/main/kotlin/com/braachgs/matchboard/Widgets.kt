package com.braachgs.matchboard

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.util.TypedValue
import android.view.View
import android.widget.RemoteViews
import dayboard.match.Band
import dayboard.match.Clubs
import dayboard.match.Match
import dayboard.match.MatchBoardBuilder
import dayboard.match.MatchBoardModel
import dayboard.match.MatchLayout
import dayboard.match.MatchRenderer
import dayboard.match.Standings
import dayboard.match.TableLayout
import dayboard.match.TableModel
import dayboard.match.TableRenderer
import java.net.URLEncoder
import java.time.ZoneId
import java.util.Locale

/** Draws every Match Board widget and arranges the next redraw. */
object Widgets {
    const val PEACOCK = "https://www.peacocktv.com/sports/premier-league"
    private val ROWS = intArrayOf(R.id.row0, R.id.row1, R.id.row2, R.id.row3, R.id.row4, R.id.row5, R.id.row6, R.id.row7, R.id.row8, R.id.row9)

    @Volatile private var typeface: Typeface? = null
    fun typeface(c: Context): Typeface =
        typeface ?: c.resources.getFont(R.font.barlow_condensed_semibold).also { typeface = it }

    fun ids(c: Context): IntArray =
        AppWidgetManager.getInstance(c).getAppWidgetIds(ComponentName(c, MatchWidget::class.java))

    val TABS = listOf("MATCHES", "CHAMPIONSHIP")
    const val PL_TABLE = "https://www.google.com/search?q=premier+league+table"
    const val ELC_TABLE = "https://www.google.com/search?q=efl+championship+table"
    const val ACTION_TAB = "com.braachgs.matchboard.TAB"
    const val EXTRA_TAB = "tab"

    /**
     * A drawn board: the bitmap, the bands of its tappable rows (matches; or
     * the table's body as one), where each header tab sits, and the models.
     */
    class Drawn(
        val bitmap: Bitmap,
        val bands: List<Band>,
        val model: MatchBoardModel,
        val tab: Int,
        val tabHits: List<Pair<Float, Float>>,
        val table: TableModel? = null,
    )

    /** The board for a [wDp] x [hDp] widget on [tab]; shared with the settings screen's preview. */
    fun render(c: Context, wDp: Float, hDp: Float, now: Long = System.currentTimeMillis(), clock: String? = null, tab: Int = 0): Drawn {
        val d = c.resources.displayMetrics.density
        val zone = ZoneId.systemDefault()
        val state = Store.feed(c, now)
        val w = (wDp * d).toInt().coerceAtLeast(1)
        val h = (hDp * d).toInt().coerceAtLeast(1)
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val painter = AndroidPainter(Canvas(bmp), typeface(c))
        val renderer = MatchRenderer(cornerRadiusDp(c))
        val matchLayout = MatchLayout(wDp * d, hDp * d, d)
        val model = MatchBoardBuilder(zone, Locale.getDefault())
            .build(state, Store.followed(c, state.matches), now, minOf(matchLayout.capacity, ROWS.size))
        if (tab == 1) {
            val l = TableLayout(wDp * d, hDp * d, d)
            val table = Standings.build(Store.table(c), Store.tableClub(c), now, zone, l.capacity)
            val band = TableRenderer(renderer).draw(painter, table, l, TABS, 1, clock)
            return Drawn(bmp, listOfNotNull(band), model, 1, renderer.tabHits, table)
        }
        val bands = renderer.draw(painter, model, matchLayout, clock, TABS)
        return Drawn(bmp, bands, model, 0, renderer.tabHits)
    }

    private fun cornerRadiusDp(c: Context): Float {
        if (Build.VERSION.SDK_INT < 31) return 16f
        return c.resources.getDimension(android.R.dimen.system_app_widget_background_radius) / c.resources.displayMetrics.density
    }

    fun updateAll(c: Context) {
        val ids = ids(c)
        if (ids.isEmpty()) {
            cancelRedraw(c)
            return
        }
        val mgr = AppWidgetManager.getInstance(c)
        val now = System.currentTimeMillis()
        var next = Long.MAX_VALUE
        try {
            for (id in ids) {
                val o = mgr.getAppWidgetOptions(id)
                val w = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH).takeIf { it > 0 }?.toFloat() ?: 250f
                val h = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT).takeIf { it > 0 }?.toFloat() ?: 110f
                val drawn = render(c, w, h, now, tab = Store.tab(c, id))
                mgr.updateAppWidget(id, views(c, id, drawn, compact = h < 190))
                next = minOf(next, drawn.model.nextChange)
            }
        } finally {
            // Always arm the next redraw, so one failure can't freeze the board.
            scheduleRedraw(c, if (next == Long.MAX_VALUE) now + 5 * 60_000 else next)
        }
    }

    /** The board cut into bands: header, one per match (each opens its own link), footer. */
    private fun views(c: Context, widgetId: Int, drawn: Drawn, compact: Boolean): RemoteViews {
        val v = RemoteViews(c.packageName, if (compact) R.layout.widget_matches_compact else R.layout.widget_matches)
        val bmp = drawn.bitmap
        val bands = drawn.bands
        val settings = PendingIntent.getActivity(c, widgetId * 16 + 15, Intent(c, SettingsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        val headBottom = bands.firstOrNull()?.top ?: bmp.height
        header(c, v, widgetId, drawn, headBottom, settings)

        if (drawn.tab == 1) {
            // The table: one tap zone, the Championship table on Google.
            ROWS.forEach { v.setViewVisibility(it, View.GONE) }
            bands.firstOrNull()?.let { band ->
                slice(v, R.id.row0, bmp, band.top, band.bottom)
                v.setViewVisibility(R.id.row0, View.VISIBLE)
                v.setOnClickPendingIntent(R.id.row0, view(c, widgetId * 16 + 0, ELC_TABLE))
                v.setContentDescription(R.id.row0, "Championship table" + (drawn.table?.favouriteLine?.let { ", ${it.lowercase()}" } ?: ""))
            }
        } else ROWS.forEachIndexed { i, slot ->
            val band = bands.getOrNull(i)
            val row = drawn.model.rows.getOrNull(i)
            if (band == null || row == null) {
                v.setViewVisibility(slot, View.GONE)
            } else {
                slice(v, slot, bmp, band.top, band.bottom)
                v.setViewVisibility(slot, View.VISIBLE)
                val open = Intent(Intent.ACTION_VIEW, link(row.match)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                v.setOnClickPendingIntent(slot, PendingIntent.getActivity(c, widgetId * 16 + i, open,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
                val score = if (row.match.homeScore != null && row.match.awayScore != null) " ${row.match.homeScore}-${row.match.awayScore}" else ""
                v.setContentDescription(slot, "${Clubs.name(row.match.home)} v ${Clubs.name(row.match.away)}$score, ${row.status.text.lowercase()}")
            }
        }
        val footTop = bands.lastOrNull()?.bottom
        if (footTop == null || footTop >= bmp.height) {
            v.setViewVisibility(R.id.foot, View.GONE)
        } else {
            slice(v, R.id.foot, bmp, footTop, bmp.height)
            v.setViewVisibility(R.id.foot, View.VISIBLE)
            v.setOnClickPendingIntent(R.id.foot, settings)
        }
        return v
    }

    private fun view(c: Context, code: Int, url: String): PendingIntent =
        PendingIntent.getActivity(c, code, Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    /**
     * The header's tap zones (Android 12+, which can size them exactly): the
     * tab on show opens its league table on Google, the other switches to
     * it, and the rest opens settings. Older Android: the whole header opens settings.
     */
    private fun header(c: Context, v: RemoteViews, widgetId: Int, drawn: Drawn, bottom: Int, settings: PendingIntent) {
        val bmp = drawn.bitmap
        val hits = drawn.tabHits
        if (Build.VERSION.SDK_INT < 31 || hits.size < 2) {
            v.setViewVisibility(R.id.tab0, View.GONE)
            v.setViewVisibility(R.id.tab1, View.GONE)
            slice(v, R.id.head, bmp, 0, bottom)
            v.setOnClickPendingIntent(R.id.head, settings)
            v.setContentDescription(R.id.head, describe(drawn.model))
            return
        }
        // Zones meet halfway between the tabs, from the board's left edge to past the second tab.
        val split = ((hits[0].second + hits[1].first) / 2).toInt().coerceIn(1, bmp.width - 2)
        val end = hits[1].second.toInt().coerceIn(split + 1, bmp.width - 1)
        val zones = listOf(Triple(R.id.tab0, 0, split), Triple(R.id.tab1, split, end))
        zones.forEachIndexed { i, (id, x0, x1) ->
            val piece = Bitmap.createBitmap(bmp, x0, 0, x1 - x0, bottom.coerceIn(1, bmp.height))
            v.setImageViewBitmap(id, piece)
            v.setViewLayoutWidth(id, (x1 - x0).toFloat(), TypedValue.COMPLEX_UNIT_PX)
            v.setViewLayoutHeight(id, piece.height.toFloat(), TypedValue.COMPLEX_UNIT_PX)
            v.setViewVisibility(id, View.VISIBLE)
            val tap = if (i == drawn.tab) view(c, widgetId * 16 + 12 + i, if (i == 0) PL_TABLE else ELC_TABLE)
            else PendingIntent.getBroadcast(c, widgetId * 16 + 12 + i,
                Intent(c, MatchWidget::class.java).setAction(ACTION_TAB)
                    .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId).putExtra(EXTRA_TAB, i),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            v.setOnClickPendingIntent(id, tap)
            v.setContentDescription(id, if (i == drawn.tab) "${TABS[i].lowercase()}, open the league table" else "show ${TABS[i].lowercase()}")
        }
        val rest = Bitmap.createBitmap(bmp, end, 0, bmp.width - end, bottom.coerceIn(1, bmp.height))
        v.setImageViewBitmap(R.id.head, rest)
        v.setViewLayoutHeight(R.id.head, rest.height.toFloat(), TypedValue.COMPLEX_UNIT_PX)
        v.setOnClickPendingIntent(R.id.head, settings)
        v.setContentDescription(R.id.head, describe(drawn.model))
    }

    private fun slice(v: RemoteViews, id: Int, bmp: Bitmap, top: Int, bottom: Int) {
        val t = top.coerceIn(0, bmp.height - 1)
        val h = (bottom.coerceAtMost(bmp.height) - t).coerceAtLeast(1)
        v.setImageViewBitmap(id, Bitmap.createBitmap(bmp, 0, t, bmp.width, h))
        // Android 12+: each band exactly its drawn height, so the bands add up to the widget.
        if (Build.VERSION.SDK_INT >= 31) v.setViewLayoutHeight(id, h.toFloat(), TypedValue.COMPLEX_UNIT_PX)
    }

    /** Finished: highlights on YouTube. Live or upcoming: Peacock's Premier League page. */
    fun link(m: Match): Uri =
        if (m.status.done) {
            val q = "${Clubs.name(m.home)} vs ${Clubs.name(m.away)} highlights Premier League NBC Sports"
            Uri.parse("https://www.youtube.com/results?search_query=" + URLEncoder.encode(q, "UTF-8"))
        } else Uri.parse(PEACOCK)

    private fun describe(m: MatchBoardModel): String =
        if (m.rows.isEmpty()) "Match Board: ${m.message?.lowercase()}" else "Match Board, ${m.footer.lowercase()}"

    private fun redrawIntent(c: Context): PendingIntent =
        PendingIntent.getBroadcast(c, 0, Intent(c, RedrawReceiver::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    /** Redraws (no network) when a countdown flap changes; doesn't wake a sleeping phone. */
    private fun scheduleRedraw(c: Context, at: Long) {
        val am = c.getSystemService(AlarmManager::class.java)
        val t = at + 1_000
        if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) am.setAndAllowWhileIdle(AlarmManager.RTC, t, redrawIntent(c))
        else am.setExactAndAllowWhileIdle(AlarmManager.RTC, t, redrawIntent(c))
    }

    fun cancelRedraw(c: Context) {
        c.getSystemService(AlarmManager::class.java).cancel(redrawIntent(c))
    }
}
