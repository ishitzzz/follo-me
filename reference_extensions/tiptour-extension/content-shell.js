/* TipTour Chrome Extension — Thin Content Shell
 *
 * This script bridges Chrome extension APIs (messages, ports, commands)
 * to the TipTour embed API (window.TipTour). All tour/agent/tooltip logic
 * lives in embed.js — this shell only handles extension-specific features.
 */
(function () {
  if (window.__tiptourShell) return
  window.__tiptourShell = true

  function tipTourStatus() {
    return {
      ok: true,
      shell: true,
      tipTour: Boolean(window.TipTour),
      embedFlag: Boolean(window.__tiptourEmbed),
      loadedAttr: document.documentElement.hasAttribute('data-tiptour-loaded'),
      url: window.location.href,
    }
  }

  function resetStaleTipTourMarkers() {
    if (window.TipTour) return tipTourStatus()
    try { delete window.__tiptourEmbed } catch {}
    document.documentElement.removeAttribute('data-tiptour-loaded')
    return tipTourStatus()
  }

  // Wait for embed.js to initialize and expose window.TipTour
  function waitForTipTour(callback, sendResponse) {
    if (window.TipTour) {
      callback(window.TipTour)
      sendResponse({ ok: true, status: tipTourStatus() })
      return
    }
    let attempts = 0
    const poll = setInterval(() => {
      attempts++
      if (window.TipTour) {
        clearInterval(poll)
        callback(window.TipTour)
        sendResponse({ ok: true, status: tipTourStatus() })
        return
      }
      if (attempts > 50) {
        clearInterval(poll)
        sendResponse({
          ok: false,
          error: 'TipTour embed did not initialize in this page context.',
          status: tipTourStatus(),
        })
      }
    }, 200)
  }

  // ─── Chrome Message Listener ─────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'ping':
        sendResponse(tipTourStatus())
        return true

      case 'tiptour-reset-stale':
        sendResponse(resetStaleTipTourMarkers())
        return true

      case 'agent-show':
        waitForTipTour(api => {
          api.show()
        }, sendResponse)
        return true

      case 'agent-chat':
        waitForTipTour(api => {
          if (typeof api.closePromptBar === 'function') api.closePromptBar()
          if (typeof api.chat === 'function') api.chat(String(msg.query || ''))
        }, sendResponse)
        return true

      case 'start-tour':
        waitForTipTour(api => {
          api.run(msg.config, { autoRun: msg.autoRun === true })
        }, sendResponse)
        return true

      case 'stop-tour':
        waitForTipTour(api => {
          api.hide()
        }, sendResponse)
        return true

      case 'toggle-voice':
        // Wired to the manifest's 'open-voice' Chrome command
        // (Cmd+Shift+K). Calls embed's TipTour.voice() which toggles
        // start/stop. Embed handles the cursor.show() + voice-wave
        // anchoring internally.
        waitForTipTour(api => {
          if (typeof api.voice === 'function') api.voice()
        }, sendResponse)
        return true

      case 'goto-step':
        // Not directly supported via embed API — would need runner access
        sendResponse({ ok: false, error: 'Not supported in thin shell' })
        return true

      case 'read-page-context':
      case 'read-page-elements':
      case 'search-page-text':
      case 'highlight-element':
        // These are handled by the agent inside embed.js automatically
        sendResponse({ ok: true, note: 'Handled by embed agent' })
        return true
    }
  })
})()
