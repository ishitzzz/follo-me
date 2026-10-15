/**
 * SemanticSnapper.js
 * Implements TipTour Auto-aim algorithm for DOM Verification.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'VERIFY_AND_SNAP') {
        const { x, y } = message.payload;
        console.log(`[SemanticSnapper] Received coordinate: (${x}, ${y})`);
        
        // 1. Check exact pixel
        const el = document.elementFromPoint(x, y);
        
        const isInteractive = (node) => {
            if (!node) return false;
            if (node.nodeType !== Node.ELEMENT_NODE) return false;
            const tag = node.tagName.toLowerCase();
            if (tag === 'a' || tag === 'button' || tag === 'input' || tag === 'select' || 
                   node.getAttribute('role') === 'button' || node.onclick || node.tabIndex >= 0) {
                return true;
            }
            try {
                const style = window.getComputedStyle(node);
                if (style && style.cursor === 'pointer') return true;
            } catch (e) {}
            return false;
        };

        if (isInteractive(el)) {
            console.log("[SemanticSnapper] Exact pixel is interactive. Snapping complete.");
            const rect = el.getBoundingClientRect();
            sendResponse({
                status: 'SUCCESS',
                payload: {
                    snappedX: rect.left + rect.width / 2,
                    snappedY: rect.top + rect.height / 2,
                    width: rect.width,
                    height: rect.height
                }
            });
            return true;
        }

        // 2. Fallback: TipTour algorithm (120px radius)
        console.log("[SemanticSnapper] Exact pixel is NOT interactive. Searching 120px radius...");
        
        let nearestEl = null;
        let minDistance = 120; // max radius

        // Scan ALL elements since cursor:pointer can be on anything
        const allElements = document.querySelectorAll('*');
        
        allElements.forEach((node) => {
            if (!isInteractive(node)) return;
            const rect = node.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return; // Hidden element
            
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            
            const distance = Math.hypot(centerX - x, centerY - y);
            if (distance < minDistance) {
                minDistance = distance;
                nearestEl = node;
            }
        });

        if (nearestEl) {
            console.log(`[SemanticSnapper] Found nearby element at distance ${minDistance}px.`);
            const rect = nearestEl.getBoundingClientRect();
            sendResponse({
                status: 'SUCCESS',
                payload: {
                    snappedX: rect.left + rect.width / 2,
                    snappedY: rect.top + rect.height / 2,
                    width: rect.width,
                    height: rect.height
                }
            });
        } else {
            console.warn("[SemanticSnapper] No interactive elements found within 80px. Flagging hallucination.");
            sendResponse({ status: 'HALLUCINATION' });
        }
    }
    return true; // Keep channel open
});
