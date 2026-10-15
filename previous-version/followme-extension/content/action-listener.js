/**
 * FolloMe - Frontend Action Listener
 * Handles receiving DOM click commands and drawing visual overlays from the background state machine.
 */

(function() {
    if (window.hasFolloMeActionListener) return;
    window.hasFolloMeActionListener = true;

    let overlayElement = null;
    let tipTourOverlay = null;

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'EXECUTE_DOM_ACTION') {
            executeDomAction(message.payload);
            sendResponse({ status: 'SUCCESS' });
        } else if (message.type === 'DRAW_OVERLAY') {
            drawOverlay(message.rect);
            sendResponse({ status: 'SUCCESS' });
        } else if (message.type === 'CLEAR_OVERLAY') {
            clearOverlay();
            sendResponse({ status: 'SUCCESS' });
        } else if (message.type === 'DRAW_TIPTOUR_OVERLAY') {
            drawTipTourOverlay(message.coordinates, message.instruction);
            sendResponse({ status: 'SUCCESS' });
        }
        return true;
    });

    function executeDomAction(payload) {
        const x = payload.x || (payload.rect && payload.rect.left) || 0;
        const y = payload.y || (payload.rect && payload.rect.top) || 0;

        console.log(`[FolloMe:ActionListener] Attempting DOM click at (${x}, ${y})`);
        
        // Find the element at the coordinates
        let element = document.elementFromPoint(x, y);
        if (!element) {
            console.warn(`[FolloMe:ActionListener] No element found at (${x}, ${y})`);
            return;
        }

        // Dispatch sequence of events
        const eventOptions = {
            view: window,
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            button: 0
        };

        element.dispatchEvent(new MouseEvent('mousedown', eventOptions));
        element.dispatchEvent(new MouseEvent('mouseup', eventOptions));
        element.dispatchEvent(new MouseEvent('click', eventOptions));
        
        // If it's a focusable input, focus it
        if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable) {
            element.focus();
        }

        console.log(`[FolloMe:ActionListener] Dispatched click to`, element);
    }

    function drawOverlay(rect) {
        if (!rect) return;
        clearOverlay(); // clear existing

        overlayElement = document.createElement('div');
        overlayElement.style.position = 'fixed';
        overlayElement.style.left = `${rect.left || rect.x}px`;
        overlayElement.style.top = `${rect.top || rect.y}px`;
        overlayElement.style.width = `${rect.width || 20}px`;
        overlayElement.style.height = `${rect.height || 20}px`;
        overlayElement.style.backgroundColor = 'rgba(255, 0, 0, 0.3)';
        overlayElement.style.border = '2px solid red';
        overlayElement.style.pointerEvents = 'none'; // let clicks pass through
        overlayElement.style.zIndex = '2147483647';
        
        document.body.appendChild(overlayElement);
    }

    function clearOverlay() {
        if (overlayElement && overlayElement.parentNode) {
            overlayElement.parentNode.removeChild(overlayElement);
        }
        overlayElement = null;
        if (tipTourOverlay && tipTourOverlay.parentNode) {
            tipTourOverlay.parentNode.removeChild(tipTourOverlay);
        }
        tipTourOverlay = null;
    }

    function drawTipTourOverlay(coords, instruction) {
        clearOverlay();

        const { x, y, width = 30, height = 30 } = coords;

        tipTourOverlay = document.createElement('div');
        tipTourOverlay.style.position = 'fixed';
        tipTourOverlay.style.left = `${x - (width/2)}px`;
        tipTourOverlay.style.top = `${y - (height/2)}px`;
        tipTourOverlay.style.width = `${width}px`;
        tipTourOverlay.style.height = `${height}px`;
        tipTourOverlay.style.border = '3px solid #00FF00';
        tipTourOverlay.style.borderRadius = '4px';
        tipTourOverlay.style.boxShadow = '0 0 10px rgba(0, 255, 0, 0.5)';
        tipTourOverlay.style.pointerEvents = 'none';
        tipTourOverlay.style.zIndex = '2147483647';

        // Add instruction tooltip
        if (instruction) {
            const tooltip = document.createElement('div');
            tooltip.textContent = instruction;
            tooltip.style.position = 'absolute';
            tooltip.style.bottom = '110%';
            tooltip.style.left = '50%';
            tooltip.style.transform = 'translateX(-50%)';
            tooltip.style.backgroundColor = '#333';
            tooltip.style.color = 'white';
            tooltip.style.padding = '5px 10px';
            tooltip.style.borderRadius = '4px';
            tooltip.style.fontSize = '12px';
            tooltip.style.whiteSpace = 'nowrap';
            tooltip.style.pointerEvents = 'none';
            tipTourOverlay.appendChild(tooltip);
        }

        document.body.appendChild(tipTourOverlay);
    }

    console.log("[FolloMe:ActionListener] Script Injected.");
})();
