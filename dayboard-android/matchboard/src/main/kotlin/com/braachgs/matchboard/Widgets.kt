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

    class Drawn(val bitmap: Bitmap, val bands: List<Band>, val model: MatchBoardModel)

    /** The board for a [wDp] x [hDp] widget; shared with the settings screen's preview. */
    fun render(c: Context, wDp: Float, hDp: Float, now: Long = System.currentTimeMillis(), clock: String? = null): Drawn {
        val d = c.resources.displayMetrics.density
        val layout = MatchLayout(wDp * d, hDp * d, d)
        val state = Store.feed(c, now)
        val model = MatchBoardBuilder(ZoneId.systemDefault(), Locale.getDefault())
            .build(state, Store.followed(c, state.matches), now, minOf(layout.capacity, ROWS.size))
        val bmp = Bitmap.createBitmap(layout.w.toInt().coerceAtLeast(1), layout.h.toInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)
        val bands = MatchRenderer(cornerRadiusDp(c)).draw(AndroidPainter(Canvas(bmp), typeface(c)), model, layout, clock)
        return Drawn(bmp, bands, model)
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
                val drawn = render(c, w, h, now)
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
        slice(v, R.id.head, bmp, 0, headBottom)
        v.setOnClickPendingIntent(R.id.head, settings)
        v.setContentDescription(R.id.head, describe(drawn.model))

        ROWS.forEachIndexed { i, slot ->
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
