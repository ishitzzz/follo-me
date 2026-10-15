/* TipTour CDP driver — background-service-worker only.
 *
 * Chrome exposes DevTools Protocol to extensions through
 * chrome.debugger. Content scripts cannot call it directly, so this
 * module owns attach/detach and low-level browser actions for the
 * active tab. It is intentionally small: higher-level target
 * resolution stays in TipTour's portable workflow/driver layer.
 */
(function initTipTourCdpDriver() {
  const PROTOCOL_VERSION = '1.3'
  const attachedTabs = new Set()
  const eventBuffers = new Map()
  const pendingDialogs = new Map()
  const networkState = new Map()
  const EVENT_BUFFER_LIMIT = 120

  function debuggeeForTab(tabId) {
    return { tabId }
  }

  function getLastErrorMessage() {
    try {
      return chrome.runtime?.lastError?.message || ''
    } catch {
      return ''
    }
  }

  function hasDebuggerApi() {
    return !!chrome.debugger?.attach && !!chrome.debugger?.sendCommand
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  function eventBufferFor(tabId) {
    let buffer = eventBuffers.get(tabId)
    if (!buffer) {
      buffer = []
      eventBuffers.set(tabId, buffer)
    }
    return buffer
  }

  function networkStateFor(tabId) {
    let state = networkState.get(tabId)
    if (!state) {
      state = { inflight: new Set(), lastActivityAt: Date.now() }
      networkState.set(tabId, state)
    }
    return state
  }

  function rememberEvent(tabId, method, params) {
    if (!Number.isInteger(tabId)) return
    const event = {
      method,
      params: summarizeEventParams(method, params || {}),
      at: Date.now(),
    }
    const buffer = eventBufferFor(tabId)
    buffer.push(event)
    if (buffer.length > EVENT_BUFFER_LIMIT) {
      buffer.splice(0, buffer.length - EVENT_BUFFER_LIMIT)
    }
  }

  function summarizeEventParams(method, params) {
    if (method === 'Network.requestWillBeSent') {
      return {
        requestId: params.requestId,
        type: params.type,
        url: params.request?.url,
      }
    }
    if (
      method === 'Network.loadingFinished' ||
      method === 'Network.loadingFailed'
    ) {
      return {
        requestId: params.requestId,
        errorText: params.errorText,
        canceled: params.canceled,
      }
    }
    if (method === 'Page.javascriptDialogOpening') {
      return {
        url: params.url,
        type: params.type,
        message: params.message,
        hasBrowserHandler: params.hasBrowserHandler,
      }
    }
    if (method === 'Page.frameNavigated') {
      return {
        frameId: params.frame?.id,
        parentId: params.frame?.parentId,
        url: params.frame?.url,
      }
    }
    if (method === 'Page.lifecycleEvent') {
      return {
        frameId: params.frameId,
        name: params.name,
      }
    }
    return params
  }

  function noteNetworkEvent(tabId, method, params) {
    const state = networkStateFor(tabId)
    if (method === 'Network.requestWillBeSent' && params?.requestId) {
      state.inflight.add(params.requestId)
      state.lastActivityAt = Date.now()
      return
    }
    if (
      (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') &&
      params?.requestId
    ) {
      state.inflight.delete(params.requestId)
      state.lastActivityAt = Date.now()
    }
  }

  function noteDialogEvent(tabId, method, params) {
    if (method === 'Page.javascriptDialogOpening') {
      pendingDialogs.set(tabId, {
        type: params?.type || 'alert',
        message: params?.message || '',
        defaultPrompt: params?.defaultPrompt || '',
        url: params?.url || '',
        at: Date.now(),
      })
      return
    }
    if (method === 'Page.javascriptDialogClosed') {
      pendingDialogs.delete(tabId)
    }
  }

  function sendCommand(tabId, method, params) {
    return new Promise((resolve, reject) => {
      if (!hasDebuggerApi()) {
        reject(new Error('chrome.debugger is unavailable. Check the debugger permission.'))
        return
      }
      try {
        chrome.debugger.sendCommand(debuggeeForTab(tabId), method, params || {}, (result) => {
          const lastErrorMessage = getLastErrorMessage()
          if (lastErrorMessage) {
            reject(new Error(lastErrorMessage))
            return
          }
          resolve(result || {})
        })
      } catch (err) {
        reject(err)
      }
    })
  }

  function attachRaw(tabId) {
    return new Promise((resolve, reject) => {
      if (!hasDebuggerApi()) {
        reject(new Error('chrome.debugger is unavailable. Check the debugger permission.'))
        return
      }
      try {
        chrome.debugger.attach(debuggeeForTab(tabId), PROTOCOL_VERSION, () => {
          const lastErrorMessage = getLastErrorMessage()
          if (lastErrorMessage) {
            reject(new Error(lastErrorMessage))
            return
          }
          attachedTabs.add(tabId)
          resolve()
        })
      } catch (err) {
        reject(err)
      }
    })
  }

  async function enableDomains(tabId) {
    const domains = ['Page.enable', 'DOM.enable', 'Runtime.enable', 'Accessibility.enable', 'Network.enable']
    for (const method of domains) {
      try {
        await sendCommand(tabId, method)
      } catch {
        // Some domains can be unavailable on restricted pages. CDP can
        // still be useful for screenshots/input, so keep the session.
      }
    }
  }

  async function attach(tabId) {
    if (!Number.isInteger(tabId)) return { ok: false, error: 'tabId is required' }
    if (attachedTabs.has(tabId)) {
      await enableDomains(tabId)
      return { ok: true, alreadyAttached: true }
    }
    await attachRaw(tabId)
    await enableDomains(tabId)
    return { ok: true }
  }

  function detach(tabId) {
    return new Promise((resolve) => {
      if (!Number.isInteger(tabId) || !attachedTabs.has(tabId) || !chrome.debugger?.detach) {
        resolve({ ok: true, alreadyDetached: true })
        return
      }
      try {
        chrome.debugger.detach(debuggeeForTab(tabId), () => {
          attachedTabs.delete(tabId)
          eventBuffers.delete(tabId)
          pendingDialogs.delete(tabId)
          networkState.delete(tabId)
          const lastErrorMessage = getLastErrorMessage()
          resolve(lastErrorMessage ? { ok: false, error: lastErrorMessage } : { ok: true })
        })
      } catch (err) {
        attachedTabs.delete(tabId)
        eventBuffers.delete(tabId)
        pendingDialogs.delete(tabId)
        networkState.delete(tabId)
        resolve({ ok: false, error: err?.message || String(err) })
      }
    })
  }

  function forgetTab(tabId) {
    if (!Number.isInteger(tabId)) return
    attachedTabs.delete(tabId)
    eventBuffers.delete(tabId)
    pendingDialogs.delete(tabId)
    networkState.delete(tabId)
  }

  try {
    chrome.tabs?.onRemoved?.addListener((tabId) => {
      forgetTab(tabId)
    })
  } catch {
    // Service worker can start in restricted contexts during tests.
  }

  try {
    chrome.debugger?.onDetach?.addListener((source) => {
      forgetTab(source?.tabId)
    })
  } catch {
    // debugger API may be unavailable when permission is missing.
  }

  async function withSession(tabId, operation) {
    await attach(tabId)
    return operation()
  }

  async function health(tabId) {
    if (!Number.isInteger(tabId)) return { ok: false, error: 'tabId is required' }
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    const url = tab?.url || ''
    const restricted = /^(chrome|chrome-extension|edge|about|devtools):/i.test(url)
    const attached = attachedTabs.has(tabId)
    const dialog = pendingDialogs.get(tabId) || null
    const network = networkStateFor(tabId)
    return {
      ok: true,
      tabId,
      url,
      title: tab?.title || '',
      restricted,
      attached,
      debuggerAvailable: hasDebuggerApi(),
      pendingDialog: dialog,
      networkInflight: network.inflight.size,
      lastNetworkActivityAt: network.lastActivityAt,
      eventCount: eventBufferFor(tabId).length,
    }
  }

  function drainEvents(tabId) {
    if (!Number.isInteger(tabId)) return { ok: false, error: 'tabId is required' }
    const events = eventBufferFor(tabId).splice(0)
    return { ok: true, events, pendingDialog: pendingDialogs.get(tabId) || null }
  }

  async function waitForNetworkIdle(tabId, options = {}) {
    if (!Number.isInteger(tabId)) return { ok: false, error: 'tabId is required' }
    const quietMs = Number.isFinite(options.quietMs) ? Math.max(0, Number(options.quietMs)) : 500
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(quietMs, Number(options.timeoutMs)) : 5000
    await attach(tabId)
    const startedAt = Date.now()
    const state = networkStateFor(tabId)
    while (Date.now() - startedAt < timeoutMs) {
      if (pendingDialogs.has(tabId)) {
        return {
          ok: true,
          idle: false,
          reason: 'dialog',
          pendingDialog: pendingDialogs.get(tabId),
        }
      }
      const quietFor = Date.now() - state.lastActivityAt
      if (state.inflight.size === 0 && quietFor >= quietMs) {
        return { ok: true, idle: true, quietFor }
      }
      await delay(50)
    }
    return {
      ok: true,
      idle: false,
      reason: 'timeout',
      inflight: state.inflight.size,
      quietFor: Date.now() - state.lastActivityAt,
    }
  }

  async function handleDialog(tabId, options = {}) {
    if (!Number.isInteger(tabId)) return { ok: false, error: 'tabId is required' }
    const dialog = pendingDialogs.get(tabId) || null
    if (!dialog) return { ok: true, handled: false }
    const accept = options.accept !== false
    const promptText = typeof options.promptText === 'string' ? options.promptText : undefined
    return withSession(tabId, async () => {
      await sendCommand(tabId, 'Page.handleJavaScriptDialog', {
        accept,
        ...(promptText !== undefined ? { promptText } : {}),
      })
      pendingDialogs.delete(tabId)
      return { ok: true, handled: true, accepted: accept, dialog }
    })
  }

  async function screenshot(tabId, options = {}) {
    return withSession(tabId, async () => {
      const result = await sendCommand(tabId, 'Page.captureScreenshot', {
        format: options.format || 'jpeg',
        quality: options.quality ?? 70,
        fromSurface: true,
      })
      return { ok: true, dataUrl: `data:image/${options.format || 'jpeg'};base64,${result.data}` }
    })
  }

  async function getSnapshot(tabId) {
    return withSession(tabId, async () => {
      const [layoutMetrics, domSnapshot, axTree] = await Promise.all([
        sendCommand(tabId, 'Page.getLayoutMetrics').catch(() => null),
        sendCommand(tabId, 'DOMSnapshot.captureSnapshot', {
          computedStyles: [],
          includeDOMRects: true,
          includePaintOrder: true,
        }).catch((err) => ({ error: err.message })),
        sendCommand(tabId, 'Accessibility.getFullAXTree').catch((err) => ({ error: err.message })),
      ])
      return {
        ok: true,
        layoutMetrics,
        domSnapshot,
        axTree,
      }
    })
  }

  async function clickAt(tabId, x, y, options = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, error: 'clickAt requires finite x/y coordinates' }
    }
    return withSession(tabId, async () => {
      const button = options.button || 'left'
      const clickCount = options.clickCount || 1
      const modifiers = options.modifiers || 0
      await sendCommand(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: 'none',
        modifiers,
      })
      await delay(40)
      await sendCommand(tabId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button,
        buttons: 1,
        clickCount,
        modifiers,
      })
      await delay(60)
      await sendCommand(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button,
        buttons: 0,
        clickCount,
        modifiers,
      })
      return { ok: true }
    })
  }

  function keyCodeForKey(key) {
    if (key.length === 1) return `Key${key.toUpperCase()}`
    const aliases = {
      Enter: 'Enter',
      Escape: 'Escape',
      Tab: 'Tab',
      Backspace: 'Backspace',
      Delete: 'Delete',
      ArrowUp: 'ArrowUp',
      ArrowDown: 'ArrowDown',
      ArrowLeft: 'ArrowLeft',
      ArrowRight: 'ArrowRight',
      Space: 'Space',
      ' ': 'Space',
    }
    return aliases[key] || key
  }

  function parseCombo(combo) {
    const parts = String(combo || '')
      .split(/[+\-]/)
      .map((part) => part.trim())
      .filter(Boolean)
    let key = parts.pop() || ''
    let modifiers = 0
    for (const raw of parts) {
      const part = raw.toLowerCase()
      if (part === 'alt' || part === 'option' || part === 'opt') modifiers |= 1
      if (part === 'ctrl' || part === 'control') modifiers |= 2
      if (part === 'cmd' || part === 'command' || part === 'meta') modifiers |= 4
      if (part === 'shift') modifiers |= 8
    }
    if (key.toLowerCase() === 'esc') key = 'Escape'
    if (key.toLowerCase() === 'space') key = ' '
    return { key, code: keyCodeForKey(key), modifiers }
  }

  async function pressKey(tabId, combo) {
    const parsed = parseCombo(combo)
    if (!parsed.key) return { ok: false, error: 'pressKey requires a key combo' }
    return withSession(tabId, async () => {
      await sendCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: parsed.key,
        code: parsed.code,
        modifiers: parsed.modifiers,
      })
      await sendCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: parsed.key,
        code: parsed.code,
        modifiers: parsed.modifiers,
      })
      return { ok: true }
    })
  }

  async function typeText(tabId, text) {
    const chars = Array.from(String(text || ''))
    return withSession(tabId, async () => {
      for (const char of chars) {
        if (char === '\n') {
          await pressKey(tabId, 'Enter')
          continue
        }
        const baseKey = char.length === 1 ? char : ''
        await sendCommand(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: baseKey,
          code: keyCodeForKey(baseKey),
        })
        await sendCommand(tabId, 'Input.dispatchKeyEvent', {
          type: 'char',
          key: char,
          text: char,
        })
        await sendCommand(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: baseKey,
          code: keyCodeForKey(baseKey),
        })
        await delay(18)
      }
      return { ok: true }
    })
  }

  async function fillAt(tabId, x, y, text) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, error: 'fillAt requires finite x/y coordinates' }
    }
    return withSession(tabId, async () => {
      await clickAt(tabId, x, y)
      await delay(80)
      const platformResult = await sendCommand(tabId, 'Runtime.evaluate', {
        expression: 'navigator.platform || navigator.userAgent || ""',
        returnByValue: true,
      }).catch(() => null)
      const platform = String(platformResult?.result?.value || '')
      const selectAllCombo = /mac/i.test(platform) ? 'Meta+A' : 'Control+A'
      await pressKey(tabId, selectAllCombo)
      await pressKey(tabId, 'Backspace')
      await typeText(tabId, text)
      return { ok: true }
    })
  }

  async function checkAt(tabId, x, y, checked) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, error: 'checkAt requires finite x/y coordinates' }
    }
    return withSession(tabId, async () => {
      const expression = `
        (() => {
          const x = ${JSON.stringify(x)};
          const y = ${JSON.stringify(y)};
          const requested = ${JSON.stringify(checked)};
          const start = document.elementFromPoint(x, y);
          if (!start) return { found: false, error: 'No element at point' };
          const target = start.closest('input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"], [role="switch"], label') || start;
          const control = target.matches('label')
            ? (target.control || target.querySelector('input[type="checkbox"], input[type="radio"]'))
            : target;
          if (control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio')) {
            if (control.disabled) return { found: true, changed: false, error: 'Control is disabled' };
            const nextChecked = typeof requested === 'boolean' ? requested : !control.checked;
            if (control.type === 'radio' && !nextChecked) {
              return { found: true, changed: false, checked: control.checked };
            }
            control.focus();
            if (control.checked !== nextChecked) {
              control.checked = nextChecked;
              control.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
              control.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            }
            return { found: true, changed: true, checked: control.checked };
          }
          const role = control.getAttribute && control.getAttribute('role');
          if (role === 'checkbox' || role === 'radio' || role === 'switch') {
            control.focus?.();
            const current = control.getAttribute('aria-checked') === 'true';
            const nextChecked = typeof requested === 'boolean' ? requested : !current;
            if (role === 'radio' && !nextChecked) {
              return { found: true, changed: false, checked: current };
            }
            if (current !== nextChecked) {
              control.setAttribute('aria-checked', String(nextChecked));
              control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y }));
              control.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
              control.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            }
            return { found: true, changed: true, checked: nextChecked };
          }
          return { found: false, error: 'No checkable element at point' };
        })()
      `
      const result = await sendCommand(tabId, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
      })
      const value = result?.result?.value
      if (!value?.found) return { ok: false, error: value?.error || 'No checkable element at point' }
      if (value.error) return { ok: false, error: value.error }
      return { ok: true, checked: value.checked, changed: value.changed }
    })
  }

  async function selectAt(tabId, x, y, option) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, error: 'selectAt requires finite x/y coordinates' }
    }
    return withSession(tabId, async () => {
      const expression = `
        (() => {
          const x = ${JSON.stringify(x)};
          const y = ${JSON.stringify(y)};
          const requested = ${JSON.stringify(option)};
          const start = document.elementFromPoint(x, y);
          if (!start) return { found: false, error: 'No element at point' };
          const select = start.closest('select');
          if (!select) return { found: false, error: 'No native select at point' };
          if (select.disabled) return { found: true, error: 'Select is disabled' };
          const options = Array.from(select.options);
          const needle = String(requested || '').trim().toLowerCase();
          const matched = needle
            ? options.find((candidate) => (
                candidate.value.toLowerCase() === needle ||
                candidate.label.trim().toLowerCase() === needle ||
                candidate.text.trim().toLowerCase() === needle ||
                candidate.text.trim().toLowerCase().includes(needle)
              ))
            : options.find((candidate) => !candidate.disabled);
          if (!matched) return { found: true, error: 'Option not found' };
          select.focus();
          select.value = matched.value;
          matched.selected = true;
          select.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          select.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          return {
            found: true,
            value: select.value,
            option: matched.text.trim() || matched.label || matched.value,
          };
        })()
      `
      const result = await sendCommand(tabId, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
      })
      const value = result?.result?.value
      if (!value?.found) return { ok: false, error: value?.error || 'No native select at point' }
      if (value.error) return { ok: false, error: value.error }
      return { ok: true, value: value.value, option: value.option }
    })
  }

  async function captureTargetAt(tabId, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, error: 'captureTargetAt requires finite x/y coordinates' }
    }
    return withSession(tabId, async () => {
      const locationResult = await sendCommand(tabId, 'DOM.getNodeForLocation', {
        x: Math.round(x),
        y: Math.round(y),
        includeUserAgentShadowDOM: true,
        ignorePointerEventsNone: true,
      }).catch(() => null)

      const expression = `
        (() => {
          const clickX = ${JSON.stringify(x)};
          const clickY = ${JSON.stringify(y)};
          const cssEscape = (value) => {
            if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
            return String(value).replace(/([!"#$%&'()*+,./:;<=>?@[\\\\\\]^\\\`{|}~])/g, '\\\\$1');
          };
          const implicitRoles = {
            BUTTON: 'button', A: 'link', INPUT: 'textbox', TEXTAREA: 'textbox',
            SELECT: 'combobox', IMG: 'img', H1: 'heading', H2: 'heading',
            H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
            NAV: 'navigation',
          };
          const shortText = (element, max = 80) => {
            const text = (element && element.textContent ? element.textContent.trim().replace(/\\s+/g, ' ') : '');
            return text.length <= max ? text : '';
          };
          const accessibleName = (element) => (
            element.getAttribute('aria-label') ||
            element.getAttribute('title') ||
            element.getAttribute('alt') ||
            element.getAttribute('placeholder') ||
            shortText(element) ||
            ''
          );
          const roleFor = (element) => {
            let role = element.getAttribute('role') || implicitRoles[element.tagName] || '';
            if (element.tagName === 'INPUT') {
              const type = (element.getAttribute('type') || '').toLowerCase();
              if (type === 'checkbox') role = 'checkbox';
              else if (type === 'radio') role = 'radio';
              else if (type === 'submit' || type === 'button') role = 'button';
            }
            return role;
          };
          const selectorMatchIndex = (selector, element) => {
            try {
              return Array.from(document.querySelectorAll(selector)).indexOf(element);
            } catch {
              return -1;
            }
          };
          const uniqueSelector = (element) => {
            if (element.id) return '#' + cssEscape(element.id);
            const testId = element.getAttribute('data-testid') || element.getAttribute('data-cy') || element.getAttribute('data-test');
            if (testId) return '[data-testid="' + cssEscape(testId) + '"]';
            const ariaLabel = element.getAttribute('aria-label');
            if (ariaLabel) {
              const selector = '[aria-label="' + cssEscape(ariaLabel) + '"]';
              try { if (document.querySelectorAll(selector).length === 1) return selector; } catch {}
            }
            const tag = element.tagName.toLowerCase();
            for (const className of Array.from(element.classList || [])) {
              if (className.length > 2 && !/[a-f0-9]{5,}/.test(className)) {
                const selector = tag + '.' + cssEscape(className);
                try { if (document.querySelectorAll(selector).length === 1) return selector; } catch {}
              }
            }
            const parts = [];
            let current = element;
            while (current && current !== document.body && parts.length < 4) {
              const currentTag = current.tagName.toLowerCase();
              if (current.id) {
                parts.unshift('#' + cssEscape(current.id));
                break;
              }
              const parent = current.parentElement;
              if (!parent) break;
              const siblings = Array.from(parent.children).filter((candidate) => candidate.tagName === current.tagName);
              parts.unshift(siblings.length > 1 ? currentTag + ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')' : currentTag);
              current = parent;
            }
            const selector = parts.join(' > ');
            try { if (selector && document.querySelector(selector) === element) return selector; } catch {}
            return selector || null;
          };
          const xpathFor = (element) => {
            if (element.id) return '//*[@id="' + element.id.replace(/"/g, '\\\\"') + '"]';
            const text = shortText(element, 40);
            const tag = element.tagName.toLowerCase();
            if (!text) return null;
            const xpath = '//' + tag + '[contains(text(), "' + text.replace(/"/g, '\\\\"') + '")]';
            try {
              const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
              return result.singleNodeValue === element ? xpath : null;
            } catch {
              return null;
            }
          };
          const actionFor = (element) => {
            const tag = element.tagName;
            if (tag === 'INPUT') {
              const type = (element.getAttribute('type') || '').toLowerCase();
              if (type === 'checkbox' || type === 'radio') return 'check';
              if (type === 'submit' || type === 'button') return 'click';
              return 'fill';
            }
            if (tag === 'TEXTAREA') return 'fill';
            if (tag === 'SELECT') return 'select';
            if (tag === 'BUTTON' || tag === 'A' || element.getAttribute('role') === 'button') return 'click';
            return 'click';
          };
          const nearestTarget = (start) => {
            if (!start || start.nodeType !== Node.ELEMENT_NODE) return null;
            return start.closest('button, a, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], label, [onclick], [tabindex]') || start;
          };
          const interactiveSelector = 'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], label, summary, [onclick], [tabindex]';
          const elementDepth = (element) => {
            let depth = 0;
            let current = element;
            while (current && current.parentElement) {
              depth += 1;
              current = current.parentElement;
            }
            return depth;
          };
          const isVisible = (element) => {
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
          };
          const distanceFromPointToRect = (pointX, pointY, rect) => {
            const nearestX = Math.max(rect.left, Math.min(rect.right, pointX));
            const nearestY = Math.max(rect.top, Math.min(rect.bottom, pointY));
            return Math.hypot(pointX - nearestX, pointY - nearestY);
          };
          const bubbleTargetAtPoint = (pointX, pointY) => {
            const candidates = Array.from(document.querySelectorAll(interactiveSelector))
              .filter(isVisible)
              .map((candidate) => {
                const rect = candidate.getBoundingClientRect();
                return {
                  element: candidate,
                  rect,
                  distance: distanceFromPointToRect(pointX, pointY, rect),
                  depth: elementDepth(candidate),
                };
              })
              .filter((candidate) => candidate.distance <= 80)
              .sort((first, second) => {
                if (first.distance !== second.distance) return first.distance - second.distance;
                return second.depth - first.depth;
              });
            return candidates[0]?.element || null;
          };
          const rawElementAtPoint = document.elementFromPoint(clickX, clickY);
          const element = bubbleTargetAtPoint(clickX, clickY) || nearestTarget(rawElementAtPoint);
          if (!element) return { found: false };
          const rect = element.getBoundingClientRect();
          const name = accessibleName(element);
          const role = roleFor(element);
          const selector = uniqueSelector(element);
          const target = {};
          if (role && name) target.ref = role + ':' + name;
          if (selector) {
            target.selector = selector;
            const matchIndex = selectorMatchIndex(selector, element);
            if (matchIndex >= 0) target.selectorMatchIndex = matchIndex;
          }
          const text = shortText(element, 60);
          if (text) target.text = text;
          const xpath = xpathFor(element);
          if (xpath) target.xpath = xpath;
          if (rect.width > 0 && rect.height > 0) {
            target.clickOffset = {
              x: Math.max(0, Math.min(1, (clickX - rect.left) / rect.width)),
              y: Math.max(0, Math.min(1, (clickY - rect.top) / rect.height)),
            };
            target.recordedRect = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
            target.recordedViewport = { width: window.innerWidth, height: window.innerHeight };
          }
          return {
            found: true,
            target,
            actionType: actionFor(element),
            label: name || element.tagName.toLowerCase(),
            tagName: element.tagName,
            rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          };
        })()
      `
      const evaluated = await sendCommand(tabId, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
      })
      const value = evaluated?.result?.value
      if (!value?.found) return { ok: false, error: 'No element found at click point' }
      value.target = value.target || {}
      let selectorNode = null
      if (value.target.selector) {
        try {
          const documentResult = await sendCommand(tabId, 'DOM.getDocument', {
            depth: 1,
            pierce: true,
          })
          const rootNodeId = documentResult?.root?.nodeId
          if (rootNodeId) {
            const matchIndex = Number(value.target.selectorMatchIndex)
            if (Number.isInteger(matchIndex) && matchIndex > 0) {
              const queryAllResult = await sendCommand(tabId, 'DOM.querySelectorAll', {
                nodeId: rootNodeId,
                selector: value.target.selector,
              })
              const nodeId = Array.isArray(queryAllResult?.nodeIds)
                ? queryAllResult.nodeIds[matchIndex]
                : null
              if (nodeId) {
                selectorNode = await sendCommand(tabId, 'DOM.describeNode', { nodeId })
              }
            }
            if (!selectorNode) {
              const queryResult = await sendCommand(tabId, 'DOM.querySelector', {
                nodeId: rootNodeId,
                selector: value.target.selector,
              })
              if (queryResult?.nodeId) {
                selectorNode = await sendCommand(tabId, 'DOM.describeNode', {
                  nodeId: queryResult.nodeId,
                })
              }
            }
          }
        } catch {
          selectorNode = null
        }
      }
      value.target.cdp = {
        backendNodeId: selectorNode?.node?.backendNodeId ?? locationResult?.backendNodeId,
        nodeId: selectorNode?.node?.nodeId ?? locationResult?.nodeId,
        frameId: locationResult?.frameId,
      }
      return { ok: true, ...value }
    })
  }

  function rectFromBoxModel(boxModel) {
    const quad = boxModel?.model?.border || boxModel?.model?.content
    if (!Array.isArray(quad) || quad.length < 8) return null
    const xs = [quad[0], quad[2], quad[4], quad[6]]
    const ys = [quad[1], quad[3], quad[5], quad[7]]
    const left = Math.min(...xs)
    const right = Math.max(...xs)
    const top = Math.min(...ys)
    const bottom = Math.max(...ys)
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    }
  }

  function pointForRect(rect, target) {
    const offset = target?.clickOffset
    const offsetX = Number(offset?.x)
    const offsetY = Number(offset?.y)
    if (Number.isFinite(offsetX) && Number.isFinite(offsetY)) {
      return {
        x: rect.x + rect.width * Math.max(0, Math.min(1, offsetX)),
        y: rect.y + rect.height * Math.max(0, Math.min(1, offsetY)),
      }
    }
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    }
  }

  async function resolveTarget(tabId, target) {
    if (!target || typeof target !== 'object') {
      return { ok: false, error: 'target is required' }
    }
    return withSession(tabId, async () => {
      const backendNodeId = Number(target?.cdp?.backendNodeId)
      if (Number.isInteger(backendNodeId) && backendNodeId > 0) {
        try {
          await sendCommand(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId })
        } catch {
          // If scrolling fails, box model may still be available.
        }
        const boxModel = await sendCommand(tabId, 'DOM.getBoxModel', { backendNodeId }).catch(() => null)
        const rect = rectFromBoxModel(boxModel)
        if (rect && rect.width > 0 && rect.height > 0) {
          return {
            ok: true,
            strategy: 'cdp-backend-node',
            rect,
            point: pointForRect(rect, target),
          }
        }
      }

      if (target.selector) {
        const expression = `
          (() => {
            const matches = Array.from(document.querySelectorAll(${JSON.stringify(target.selector)}));
            const matchIndex = ${JSON.stringify(target.selectorMatchIndex ?? null)};
            const el = Number.isInteger(matchIndex) && matchIndex >= 0 && matchIndex < matches.length
              ? matches[matchIndex]
              : matches[0];
            if (!el) return { found: false };
            el.scrollIntoView({ block: 'center', inline: 'center' });
            const rect = el.getBoundingClientRect();
            const clickOffset = ${JSON.stringify(target.clickOffset ?? null)};
            const point = clickOffset && Number.isFinite(clickOffset.x) && Number.isFinite(clickOffset.y)
              ? {
                  x: rect.left + rect.width * Math.max(0, Math.min(1, clickOffset.x)),
                  y: rect.top + rect.height * Math.max(0, Math.min(1, clickOffset.y)),
                }
              : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            return {
              found: rect.width > 0 && rect.height > 0,
              rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
              point,
            };
          })()
        `
        const result = await sendCommand(tabId, 'Runtime.evaluate', {
          expression,
          returnByValue: true,
        }).catch(() => null)
        const value = result?.result?.value
        if (value?.found) {
          return {
            ok: true,
            strategy: 'cdp-selector',
            rect: value.rect,
            point: value.point,
          }
        }
      }

      return { ok: false, error: 'CDP target resolution failed' }
    })
  }

  async function clickSelector(tabId, selector) {
    if (!selector) return { ok: false, error: 'selector is required' }
    return withSession(tabId, async () => {
      const expression = `
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { found: false };
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const rect = el.getBoundingClientRect();
          return {
            found: true,
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          };
        })()
      `
      const result = await sendCommand(tabId, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
      })
      const value = result?.result?.value
      if (!value?.found) return { ok: false, error: 'selector not found' }
      return clickAt(tabId, value.x, value.y)
    })
  }

  chrome.debugger?.onEvent?.addListener((source, method, params) => {
    const tabId = source?.tabId
    if (!Number.isInteger(tabId)) return
    rememberEvent(tabId, method, params)
    noteNetworkEvent(tabId, method, params || {})
    noteDialogEvent(tabId, method, params || {})
  })

  chrome.debugger?.onDetach?.addListener((source) => {
    forgetTab(source?.tabId)
  })

  self.TipTourCdpDriver = {
    attach,
    detach,
    health,
    drainEvents,
    waitForNetworkIdle,
    handleDialog,
    sendCommand,
    screenshot,
    getSnapshot,
    clickAt,
    clickSelector,
    captureTargetAt,
    resolveTarget,
    fillAt,
    checkAt,
    selectAt,
    pressKey,
    typeText,
    isAttached(tabId) {
      return attachedTabs.has(tabId)
    },
  }
})()
