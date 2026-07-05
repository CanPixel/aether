package com.canur.aether

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Bitmap
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

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

  override fun load(webView: WebView) {
    mainWebView = webView
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
    val view = WebView(activity)
    view.settings.javaScriptEnabled = true
    view.settings.domStorageEnabled = true
    view.settings.setSupportZoom(true)
    view.settings.builtInZoomControls = true
    view.settings.displayZoomControls = false
    view.settings.loadWithOverviewMode = true
    view.settings.useWideViewPort = true
    // target=_blank falls back to same-view navigation with multiple windows off.
    view.settings.setSupportMultipleWindows(false)

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
      tabs.remove(args.tabId)?.let { view ->
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
      }
    }
    invoke.resolve()
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
