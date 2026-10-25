package com.braachgs.matchboard

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import dayboard.core.Align
import dayboard.core.Painter

/** As Day Board's: draws the board onto an Android [Canvas] in the flap typeface (Barlow Condensed). */
class AndroidPainter(private val canvas: Canvas, typeface: Typeface) : Painter {
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val ink = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG).apply { this.typeface = typeface }
    private val bounds = Rect()

    override fun rect(x: Float, y: Float, w: Float, h: Float, color: Int, radius: Float) {
        fill.color = color
        if (radius > 0) canvas.drawRoundRect(x, y, x + w, y + h, radius, radius, fill)
        else canvas.drawRect(x, y, x + w, y + h, fill)
    }

    override fun text(s: String, x: Float, baseline: Float, size: Float, color: Int, align: Align, tracking: Float) {
        ink.textSize = size
        ink.letterSpacing = tracking
        ink.color = color
        ink.textAlign = when (align) {
            Align.LEFT -> Paint.Align.LEFT
            Align.CENTER -> Paint.Align.CENTER
            Align.RIGHT -> Paint.Align.RIGHT
        }
        canvas.drawText(s, x, baseline, ink)
    }

    override fun measure(s: String, size: Float, tracking: Float): Float {
        ink.textSize = size
        ink.letterSpacing = tracking
        return ink.measureText(s)
    }

    override fun capHeight(size: Float): Float {
        ink.textSize = size
        ink.letterSpacing = 0f
        ink.getTextBounds("H", 0, 1, bounds)
        return bounds.height().toFloat()
    }
}
