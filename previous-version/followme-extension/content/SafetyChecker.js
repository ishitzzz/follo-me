/**
 * SafetyChecker.js
 * Implements Lyto Z-index and bounding box safety checks.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'CHECK_OVERLAY') {
        const { x, y } = message.payload;
        console.log(`[SafetyChecker] Checking overlay at coordinate: (${x}, ${y})`);
        
        const el = document.elementFromPoint(x, y);
        if (!el || el.tagName === 'BODY' || el.tagName === 'HTML') {
            sendResponse({ status: 'CLEAR' });
            return true;
        }

        const rect = el.getBoundingClientRect();
        const viewportArea = window.innerWidth * window.innerHeight;
        const elArea = rect.width * rect.height;

        // If the element covers more than 50% of the viewport, it's likely a modal or overlay
        if (elArea > viewportArea * 0.5) {
            const style = window.getComputedStyle(el);
            if (style.position === 'fixed' || style.position === 'absolute' || el.tagName === 'DIALOG') {
                console.warn(`[SafetyChecker] Massive overlay detected. Element covers ${((elArea/viewportArea)*100).toFixed(1)}% of viewport.`);
                sendResponse({ status: 'OVERLAY_DETECTED' });
                return true;
            }
        }
        
        console.log(`[SafetyChecker] Target is clear of massive overlays.`);
        sendResponse({ status: 'CLEAR' });
    }
    return true; // Keep channel open
});
