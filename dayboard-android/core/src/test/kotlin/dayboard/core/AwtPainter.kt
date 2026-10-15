package dayboard.core

import java.awt.Color
import java.awt.Font
import java.awt.Graphics2D
import java.awt.RenderingHints
import java.awt.font.TextAttribute
import java.awt.geom.Rectangle2D
import java.awt.geom.RoundRectangle2D
import java.awt.image.BufferedImage

/** Java2D stand-in for the Android Canvas painter, for previews and layout tests. */
class AwtPainter(private val g: Graphics2D, private val base: Font) : Painter {
    init {
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON)
        g.setRenderingHint(RenderingHints.KEY_FRACTIONALMETRICS, RenderingHints.VALUE_FRACTIONALMETRICS_ON)
    }

    private fun font(size: Float, tracking: Float): Font =
        base.deriveFont(size).deriveFont(mapOf(TextAttribute.TRACKING to tracking))

    override fun rect(x: Float, y: Float, w: Float, h: Float, color: Int, radius: Float) {
        g.color = Color(color, true)
        g.fill(if (radius > 0) RoundRectangle2D.Float(x, y, w, h, radius * 2, radius * 2) else Rectangle2D.Float(x, y, w, h))
    }

    override fun text(s: String, x: Float, baseline: Float, size: Float, color: Int, align: Align, tracking: Float) {
        val f = font(size, tracking)
        g.font = f
        g.color = Color(color, true)
        val w = measure(s, size, tracking)
        val left = when (align) { Align.LEFT -> x; Align.CENTER -> x - w / 2; Align.RIGHT -> x - w }
        g.drawString(s, left, baseline)
    }

    override fun measure(s: String, size: Float, tracking: Float): Float =
        font(size, tracking).getStringBounds(s, g.fontRenderContext).width.toFloat()

    override fun capHeight(size: Float): Float =
        font(size, 0f).createGlyphVector(g.fontRenderContext, "H").visualBounds.height.toFloat()

    companion object {
        val flapFont: Font by lazy {
            AwtPainter::class.java.getResourceAsStream("/barlow_condensed_semibold.ttf").use { Font.createFont(Font.TRUETYPE_FONT, it) }
        }

        fun image(w: Int, h: Int, draw: (Painter) -> Unit): BufferedImage {
            val img = BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB)
            val g = img.createGraphics()
            draw(AwtPainter(g, flapFont))
            g.dispose()
            return img
        }
    }
}
