(function() {
    if (globalThis.__folloMeTelemetryInitialized) return;
    globalThis.__folloMeTelemetryInitialized = true;

    const TELEMETRY_URL = 'http://localhost:3005/log';
    
    // Determine context (Service Worker, Content Script, or Popup)
    let contextName = 'Unknown';
    if (typeof chrome !== 'undefined' && chrome.extension && chrome.extension.getBackgroundPage && chrome.extension.getBackgroundPage() === window) {
        contextName = 'BackgroundPage';
    } else if (typeof window !== 'undefined' && window.document) {
        contextName = window.location.pathname.includes('popup') ? 'Popup' : 'ContentScript';
    } else if (typeof self !== 'undefined' && self.ServiceWorkerGlobalScope) {
        contextName = 'ServiceWorker';
    }

    // 1. Monkey-patch Console & Fetch references early
    const _originalLog = console.log;
    const _originalError = console.error;
    const _originalWarn = console.warn;
    const _originalFetch = globalThis.fetch;

    // Helper to send telemetry
    function sendTelemetry(payload) {
        // Make sure the fetch POST requests are non-blocking and wrapped in a try...catch
        // so they gracefully fail without breaking the extension's primary execution.
        try {
            if (typeof _originalFetch !== 'undefined') {
                _originalFetch.call(globalThis, TELEMETRY_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).catch(err => {
                    if (typeof _originalWarn === 'function') {
                        _originalWarn.call(console, '[Telemetry] Server offline or error:', err.message);
                    }
                });
            } else if (typeof XMLHttpRequest !== 'undefined') {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', TELEMETRY_URL, true);
                xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.onerror = function() {
                    if (typeof _originalWarn === 'function') {
                        _originalWarn.call(console, '[Telemetry] Server offline (XHR error)');
                    }
                };
                xhr.send(JSON.stringify(payload));
            }
        } catch (e) {
            if (typeof _originalWarn === 'function') {
                _originalWarn.call(console, '[Telemetry] Sync error preparing telemetry:', e.message);
            }
        }
    }

    function formatArgs(args) {
        return Array.from(args).map(arg => {
            if (arg instanceof Error) {
                return JSON.stringify({ message: arg.message, name: arg.name, stack: arg.stack });
            }
            if (typeof arg === 'object') {
                try {
                    return JSON.stringify(arg);
                } catch(e) {
                    return String(arg);
                }
            }
            return String(arg);
        }).join(' ');
    }

    console.log = function(...args) {
        _originalLog.apply(console, args);
        sendTelemetry({ type: 'log', level: 'info', context: contextName, message: formatArgs(args) });
    };

    console.error = function(...args) {
        _originalError.apply(console, args);
        sendTelemetry({ type: 'log', level: 'error', context: contextName, message: formatArgs(args) });
    };

    console.warn = function(...args) {
        _originalWarn.apply(console, args);
        sendTelemetry({ type: 'log', level: 'warn', context: contextName, message: formatArgs(args) });
    };

    // 2. Monkey-patch Fetch for LLM calls
    // _originalFetch is defined at the top
    globalThis.fetch = async function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : 'unknown');
        
        // Don't intercept our own telemetry calls!
        if (url.includes('localhost:3005')) {
            return _originalFetch.apply(this, args);
        }

        const options = args[1] || {};
        
        // Log Request
        if (url.includes('groq.com') || url.includes('openai.com') || url.includes('anthropic') || url.includes('openrouter.ai') || (options.method && options.method.toUpperCase() === 'POST')) {
            sendTelemetry({
                type: 'network',
                event: 'request',
                context: contextName,
                url: url,
                method: options.method || 'GET',
                body: options.body ? options.body : null
            });
        }

        try {
            const response = await _originalFetch.apply(this, args);
            const clone = response.clone();
            
            // Log Response
            if (url.includes('groq.com') || url.includes('openai.com') || url.includes('anthropic') || url.includes('openrouter.ai')) {
                clone.text().then(text => {
                    sendTelemetry({
                        type: 'network',
                        event: 'response',
                        context: contextName,
                        url: url,
                        status: clone.status,
                        body: text
                    });
                }).catch(() => {});
            }
            return response;
        } catch (error) {
            sendTelemetry({ type: 'log', level: 'error', context: contextName, message: `Fetch Error (${url}): ${error.message}` });
            throw error;
        }
    };

})();
