package com.braachgs.matchboard

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.util.Log
import java.util.concurrent.Executors

internal val worker = Executors.newSingleThreadExecutor()

/** Redraws off the main thread, keeping the receiver alive until it's done. */
internal fun BroadcastReceiver.inBackground(context: Context, work: (Context) -> Unit) {
    val pending = goAsync()
    val app = context.applicationContext
    worker.execute {
        try {
            work(app)
        } catch (e: Exception) {
            Log.e("MatchBoard", "widget update failed", e)
        } finally {
            pending.finish()
        }
    }
}

/** The home-screen widget. Drawing uses stored data; fetching is WorkManager's job. */
class MatchWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = inBackground(context) { c ->
        Widgets.updateAll(c)
        Refresh.ensurePeriodic(c)
        val asOf = Store.feed(c).fetchedAt
        if (Store.apiKey(c).isNotEmpty() && (asOf == null || System.currentTimeMillis() - asOf > 15 * 60_000)) Refresh.now(c)
    }

    /** A header tab was tapped: show that tab on that widget. */
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Widgets.ACTION_TAB) {
            val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            val tab = intent.getIntExtra(Widgets.EXTRA_TAB, 0).coerceIn(0, 1)
            if (id != AppWidgetManager.INVALID_APPWIDGET_ID) inBackground(context) { c ->
                Store.setTab(c, id, tab)
                Widgets.updateAll(c)
                // First look at the table with nothing stored: fetch it now.
                if (tab == 1 && Store.apiKey(c).isNotEmpty() && Store.tableAt(c) == 0L) {
                    Feed.table(c, Store.apiKey(c), force = true)
                    Widgets.updateAll(c)
                }
            }
            return
        }
        super.onReceive(context, intent)
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) =
        inBackground(context) { Widgets.updateAll(it) } // resized

    override fun onDisabled(context: Context) = inBackground(context) { c ->
        Refresh.stopAll(c)
        Widgets.cancelRedraw(c)
    }
}

/** A countdown flap changes (IN 20 MIN to IN 15 MIN, kickoff, midnight). */
class RedrawReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = inBackground(context) { Widgets.updateAll(it) }
}
