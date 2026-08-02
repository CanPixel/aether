package com.canur.aether

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.SystemClock
import android.util.Base64
import android.util.LruCache
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayOutputStream

// Per-tab browser WebViews for Android.
//
// Tauri's multi-webview API (`Window::add_child`) is desktop-only, so on
// Android each ÆTHER browser tab gets a plain android.webkit.WebView added to
// the activity's content view above the main (app UI) webview. Rust drives
// this plugin through `run_mobile_plugin` (see the `android_tabs` module in
// src-tauri/src/lib.rs) and stays the single source of truth for tab state;
// navigation/title/find events flow back by evaluating
// `window.__AETHER_TAB_EVENT__(...)` in the main webview, which forwards them
// to the `aether_tabs_report_native_event` command.
//
// Bounds arrive in CSS pixels measured by the renderer (MobileTabView) and are
// converted to device pixels with the display density. All WebView access
// happens on the UI thread.

@InvokeArg
class EnsureArgs {
  lateinit var tabId: String
  lateinit var url: String
}

@InvokeArg
class NavigateArgs {
  lateinit var tabId: String
  lateinit var url: String
}

@InvokeArg
class SyncArgs {
  var activeTabId: String? = null
  var top: Double = 0.0
  var left: Double = 0.0
  var width: Double = 0.0
  var height: Double = 0.0
}

@InvokeArg
class TabArgs {
  lateinit var tabId: String
}

@InvokeArg
class EvalArgs {
  lateinit var tabId: String
  lateinit var script: String
}

@InvokeArg
class FindArgs {
  lateinit var tabId: String
  var query: String? = null
  var action: String = "find"
}

@TauriPlugin
class TabsPlugin(private val activity: Activity) : Plugin(activity) {
  private var mainWebView: WebView? = null
  private val tabs = HashMap<String, WebView>()

  // Downscaled page bitmaps for the mobile tab-grid switcher, captured whenever
  // a visible tab gets hidden (sync) and on demand for the active tab. Sized in
  // bytes so a couple dozen tabs stay well under typical heap budgets.
  private val thumbnails = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
    override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
  }

  override fun load(webView: WebView) {
    mainWebView = webView
    // MainActivity runs edge-to-edge (enableEdgeToEdge, targetSdk 36), so the
    // renderer must pad around the system bars itself. env(safe-area-inset-*)
    // is unreliable in WebView, so push the insets as CSS variables instead;
    // the renderer also pulls them once at startup via the `insets` command in
    // case this listener fired before the app document loaded.
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      applyInsetVariables(view as WebView, insets)
      insets
    }
  }

  private fun currentInsets(): WindowInsetsCompat? {
    val root = activity.findViewById<ViewGroup>(android.R.id.content)
    return ViewCompat.getRootWindowInsets(root)
  }

  private fun insetValues(insets: WindowInsetsCompat): DoubleArray {
    val bars = insets.getInsets(
      WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
    )
    // The soft keyboard reports through the same inset system; folding it into
    // the bottom inset lifts the chrome, sheets, and toasts above the IME so
    // focused inputs stay visible while typing.
    val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
    val density = activity.resources.displayMetrics.density.toDouble()
    return doubleArrayOf(
      bars.top / density,
      maxOf(bars.bottom, ime.bottom) / density,
      bars.left / density,
      bars.right / density
    )
  }

  private fun applyInsetVariables(webView: WebView, insets: WindowInsetsCompat) {
    val values = insetValues(insets)
    val js =
      "document.documentElement.style.setProperty('--aether-inset-top','${values[0]}px');" +
        "document.documentElement.style.setProperty('--aether-inset-bottom','${values[1]}px');" +
        "document.documentElement.style.setProperty('--aether-inset-left','${values[2]}px');" +
        "document.documentElement.style.setProperty('--aether-inset-right','${values[3]}px');"
    webView.post { webView.evaluateJavascript(js, null) }
  }

  // System-bar/cutout insets in CSS pixels for the renderer's mobile layout.
  @Command
  fun insets(invoke: Invoke) {
    activity.runOnUiThread {
      val result = JSObject()
      val values = currentInsets()?.let { insetValues(it) } ?: doubleArrayOf(0.0, 0.0, 0.0, 0.0)
      result.put("top", values[0])
      result.put("bottom", values[1])
      result.put("left", values[2])
      result.put("right", values[3])
      invoke.resolve(result)
    }
  }

  // A browser-tab WebView that reports scroll movement to the renderer so the
  // mobile bottom chrome can auto-hide. Throttled: at most one event per
  // ~80 ms once at least 8 px of movement accumulated. The renderer applies
  // its own hysteresis, so precision here does not matter.
  @SuppressLint("ViewConstructor")
  private inner class TabWebView(context: Context, private val tabId: String) : WebView(context) {
    private var lastEmit = 0L
    private var pendingDelta = 0

    override fun onScrollChanged(left: Int, top: Int, oldLeft: Int, oldTop: Int) {
      super.onScrollChanged(left, top, oldLeft, oldTop)
      pendingDelta += top - oldTop
      val now = SystemClock.uptimeMillis()
      if (kotlin.math.abs(pendingDelta) < 8 || now - lastEmit < 80) return
      val payload = JSObject()
      payload.put("tabId", tabId)
      payload.put("kind", "scroll")
      payload.put("scrollY", top)
      payload.put("deltaY", pendingDelta)
      lastEmit = now
      pendingDelta = 0
      emitTabEvent(payload)
    }
  }

  // Draws the visible viewport into a downscaled bitmap. Software canvas draw
  // is the supported capture path for WebView; failures (composited video,
  // zero-sized view) just skip the thumbnail.
  private fun captureThumbnail(tabId: String, view: WebView) {
    if (view.width <= 0 || view.height <= 0) return
    val scale = 0.34f
    val width = (view.width * scale).toInt().coerceAtLeast(1)
    val height = (view.height * scale).toInt().coerceAtLeast(1)
    try {
      val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.RGB_565)
      val canvas = Canvas(bitmap)
      canvas.scale(scale, scale)
      canvas.translate(-view.scrollX.toFloat(), -view.scrollY.toFloat())
      view.draw(canvas)
      thumbnails.put(tabId, bitmap)
    } catch (_: Throwable) {
      // Never let a capture failure break tab switching.
    }
  }

  private fun emitTabEvent(payload: JSObject) {
    val js = "window.__AETHER_TAB_EVENT__ && window.__AETHER_TAB_EVENT__($payload)"
    activity.runOnUiThread { mainWebView?.evaluateJavascript(js, null) }
  }

  private fun navigationEvent(tabId: String, view: WebView, url: String?, isLoading: Boolean) {
    val payload = JSObject()
    payload.put("tabId", tabId)
    payload.put("kind", "navigation")
    payload.put("url", url ?: view.url ?: "")
    payload.put("isLoading", isLoading)
    payload.put("canGoBack", view.canGoBack())
    payload.put("canGoForward", view.canGoForward())
    emitTabEvent(payload)
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun createTab(tabId: String, url: String): WebView {
    val view: WebView = TabWebView(activity, tabId)
    view.settings.javaScriptEnabled = true
    view.settings.domStorageEnabled = true
    view.settings.setSupportZoom(true)
    view.settings.builtInZoomControls = true
    view.settings.displayZoomControls = false
    view.settings.loadWithOverviewMode = true
    view.settings.useWideViewPort = true
    // target=_blank falls back to same-view navigation with multiple windows off.
    view.settings.setSupportMultipleWindows(false)

    // Matches BROWSER_USER_AGENT in src-tauri/src/lib.rs. The stock WebView UA
    // carries a "; wv" token that marks every request as coming from an embedded
    // view rather than a browser, which is a needless narrowing of the crowd.
    view.settings.userAgentString =
      "Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/137.0.0.0 Mobile Safari/537.36"

    // Android is the one platform whose webview exposes a third-party cookie
    // switch; wry has no desktop equivalent, so this defence is mobile-only.
    CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)

    view.webViewClient = object : WebViewClient() {
      override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        navigationEvent(tabId, view, url, true)
      }

      override fun onPageFinished(view: WebView, url: String?) {
        navigationEvent(tabId, view, url, false)
      }

      override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
        navigationEvent(tabId, view, url, false)
      }
    }

    view.webChromeClient = object : WebChromeClient() {
      override fun onReceivedTitle(view: WebView, title: String?) {
        if (title.isNullOrBlank()) return
        val payload = JSObject()
        payload.put("tabId", tabId)
        payload.put("kind", "title")
        payload.put("title", title)
        emitTabEvent(payload)
      }
    }

    view.setFindListener { activeMatchOrdinal, numberOfMatches, isDoneCounting ->
      if (isDoneCounting) {
        val payload = JSObject()
        payload.put("tabId", tabId)
        payload.put("kind", "find")
        payload.put("current", if (numberOfMatches > 0) activeMatchOrdinal + 1 else 0)
        payload.put("total", numberOfMatches)
        emitTabEvent(payload)
      }
    }

    view.visibility = View.GONE
    val root = activity.findViewById<ViewGroup>(android.R.id.content)
    // Added after the main webview, so tab views draw above the app UI; the
    // renderer keeps chrome (address bar, tab strip) outside the tab bounds,
    // mirroring the desktop child-webview layering.
    root.addView(view, FrameLayout.LayoutParams(0, 0))
    view.loadUrl(url)
    tabs[tabId] = view
    return view
  }

  @Command
  fun ensure(invoke: Invoke) {
    val args = invoke.parseArgs(EnsureArgs::class.java)
    activity.runOnUiThread {
      if (!tabs.containsKey(args.tabId)) {
        createTab(args.tabId, args.url)
      }
    }
    invoke.resolve()
  }

  @Command
  fun navigate(invoke: Invoke) {
    val args = invoke.parseArgs(NavigateArgs::class.java)
    activity.runOnUiThread {
      val view = tabs[args.tabId]
      if (view == null) {
        // createTab already loads the URL.
        createTab(args.tabId, args.url)
      } else {
        view.loadUrl(args.url)
      }
    }
    invoke.resolve()
  }

  @Command
  fun sync(invoke: Invoke) {
    val args = invoke.parseArgs(SyncArgs::class.java)
    activity.runOnUiThread {
      val density = activity.resources.displayMetrics.density
      for ((tabId, view) in tabs) {
        // Keep the switcher preview fresh: snapshot any tab that is about to
        // be hidden while still laid out and visible.
        if (view.visibility == View.VISIBLE && tabId != args.activeTabId) {
          captureThumbnail(tabId, view)
        }
        if (tabId == args.activeTabId) {
          val params = FrameLayout.LayoutParams(
            (args.width * density).toInt().coerceAtLeast(0),
            (args.height * density).toInt().coerceAtLeast(0)
          )
          params.leftMargin = (args.left * density).toInt()
          params.topMargin = (args.top * density).toInt()
          view.layoutParams = params
          view.visibility = View.VISIBLE
        } else {
          view.visibility = View.GONE
        }
      }
    }
    invoke.resolve()
  }

  @Command
  fun goBack(invoke: Invoke) {
    val args = invoke.parseArgs(TabArgs::class.java)
    activity.runOnUiThread {
      val view = tabs[args.tabId]
      if (view != null && view.canGoBack()) {
        view.goBack()
      }
    }
    invoke.resolve()
  }

  @Command
  fun goForward(invoke: Invoke) {
    val args = invoke.parseArgs(TabArgs::class.java)
    activity.runOnUiThread {
      val view = tabs[args.tabId]
      if (view != null && view.canGoForward()) {
        view.goForward()
      }
    }
    invoke.resolve()
  }

  @Command
  fun close(invoke: Invoke) {
    val args = invoke.parseArgs(TabArgs::class.java)
    activity.runOnUiThread {
      thumbnails.remove(args.tabId)
      tabs.remove(args.tabId)?.let { view ->
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
      }
    }
    invoke.resolve()
  }

  // Returns a data-URI JPEG preview for the tab-grid switcher, refreshing the
  // capture first when the tab is currently visible. Resolves an empty object
  // when no preview exists yet (e.g. a tab that never became visible).
  @Command
  fun thumbnail(invoke: Invoke) {
    val args = invoke.parseArgs(TabArgs::class.java)
    activity.runOnUiThread {
      val view = tabs[args.tabId]
      if (view != null && view.visibility == View.VISIBLE) {
        captureThumbnail(args.tabId, view)
      }
      val result = JSObject()
      val bitmap = thumbnails.get(args.tabId)
      if (bitmap != null) {
        val stream = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 68, stream)
        val encoded = Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
        result.put("image", "data:image/jpeg;base64,$encoded")
      }
      invoke.resolve(result)
    }
  }

  // Live-DOM page snapshot for capture: unlike desktop, Android's
  // evaluateJavascript has a value callback, so Rust can read the rendered
  // page (logged-in / JS-built content) instead of re-fetching the URL.
  // Mirrors the desktop extract_readable_page_from_webview script.
  @Command
  fun snapshot(invoke: Invoke) {
    val args = invoke.parseArgs(TabArgs::class.java)
    activity.runOnUiThread {
      val view = tabs[args.tabId]
      if (view == null) {
        invoke.reject("Tab webview is not ready.")
        return@runOnUiThread
      }
      val script = """(() => {
        const schemaTypes = new Set(['Article', 'NewsArticle', 'BlogPosting', 'TechArticle', 'Report']);
        const schemaNodes = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
          .flatMap((node) => {
            try {
              const parsed = JSON.parse(node.textContent || 'null');
              const roots = Array.isArray(parsed) ? parsed : [parsed];
              return roots.flatMap((root) => Array.isArray(root?.['@graph']) ? root['@graph'] : [root]);
            } catch (_) { return []; }
          });
        const articleSchema = schemaNodes.find((node) => {
          const types = Array.isArray(node?.['@type']) ? node['@type'] : [node?.['@type']];
          return types.some((type) => schemaTypes.has(type));
        }) || {};
        const schemaName = (value) => {
          if (typeof value === 'string') return value;
          if (Array.isArray(value)) return value.map(schemaName).filter(Boolean).join(', ');
          return typeof value?.name === 'string' ? value.name : '';
        };
        const schemaUrl = (value) => {
          if (typeof value === 'string') return value;
          return typeof value?.['@id'] === 'string' ? value['@id'] : '';
        };
        const clone = document.documentElement.cloneNode(true);
        clone.querySelectorAll('script, style, noscript, iframe, form, nav, footer, svg').forEach((node) => node.remove());
        return {
          html: '<!doctype html>' + clone.outerHTML,
          url: location.href,
          title: document.title,
          description: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
          bodyText: document.body?.innerText || '',
          canonicalUrl: document.querySelector('link[rel~="canonical"]')?.href ||
            document.querySelector('meta[property="og:url"]')?.getAttribute('content') ||
            schemaUrl(articleSchema.mainEntityOfPage) || schemaUrl(articleSchema.url),
          author: document.querySelector('meta[name="author"]')?.getAttribute('content') ||
            document.querySelector('meta[property="article:author"]')?.getAttribute('content') ||
            schemaName(articleSchema.author),
          publishedAt: document.querySelector('meta[property="article:published_time"]')?.getAttribute('content') ||
            document.querySelector('meta[itemprop="datePublished"]')?.getAttribute('content') ||
            articleSchema.datePublished || articleSchema.dateCreated || '',
          siteName: document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ||
            schemaName(articleSchema.publisher) || schemaName(articleSchema.isPartOf),
          language: document.documentElement.lang || articleSchema.inLanguage || '',
          selectedText: window.getSelection()?.toString() || ''
        };
      })()"""
      view.evaluateJavascript(script) { value ->
        val result = JSObject()
        result.put("payload", value ?: "")
        invoke.resolve(result)
      }
    }
  }

  @Command
  fun eval(invoke: Invoke) {
    val args = invoke.parseArgs(EvalArgs::class.java)
    activity.runOnUiThread {
      tabs[args.tabId]?.evaluateJavascript(args.script, null)
    }
    invoke.resolve()
  }

  @Command
  fun find(invoke: Invoke) {
    val args = invoke.parseArgs(FindArgs::class.java)
    activity.runOnUiThread {
      val view = tabs[args.tabId] ?: return@runOnUiThread
      when (args.action) {
        "next" -> view.findNext(true)
        "prev" -> view.findNext(false)
        "clear" -> view.clearMatches()
        else -> {
          val query = args.query
          if (query.isNullOrBlank()) {
            view.clearMatches()
          } else {
            view.findAllAsync(query)
          }
        }
      }
    }
    invoke.resolve()
  }
}
