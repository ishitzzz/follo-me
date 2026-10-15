const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const EXTENSION_PATH = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.resolve(__dirname, 'output');

if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function runTest() {
    console.log('[TestRunner] Launching Chrome...');
    
    // Launch Chrome with the extension loaded
    const browser = await puppeteer.launch({
        headless: false, // We need to see what's happening
        defaultViewport: null,
        args: [
            `--disable-extensions-except=${EXTENSION_PATH}`,
            `--load-extension=${EXTENSION_PATH}`,
            `--disable-infobars`,
            `--window-size=1280,800`
        ]
    });

    console.log('[TestRunner] Waiting for Service Worker target...');
    
    // Find the Background Service Worker target
    const workerTarget = await browser.waitForTarget(
        target => target.type() === 'service_worker'
    );
    
    const worker = await workerTarget.worker();

    // 1. Hook into Console Logs
    worker.on('console', msg => {
        const type = msg.type().toUpperCase();
        let colorPrefix = '';
        let colorSuffix = '\x1b[0m';
        if (type === 'ERROR') colorPrefix = '\x1b[31m'; // Red
        else if (type === 'WARNING') colorPrefix = '\x1b[33m'; // Yellow
        else colorPrefix = '\x1b[36m'; // Cyan

        console.log(`${colorPrefix}[ServiceWorker:${type}] ${msg.text()}${colorSuffix}`);
    });

    worker.on('pageerror', err => {
        console.error(`\x1b[31m[ServiceWorker:EXCEPTION] ${err.message}\x1b[0m`);
    });

    // 2. Hook into CDP to intercept Network Requests
    console.log('[TestRunner] Attaching CDP Session to Service Worker...');
    const client = await workerTarget.createCDPSession();
    await client.send('Network.enable');

    let imageCounter = 1;

    client.on('Network.requestWillBeSent', params => {
        const request = params.request;
        const url = request.url;
        
        // Log API calls to external services
        if (url.includes('groq.com') || url.includes('openai.com') || url.includes('anthropic') || request.method === 'POST') {
            console.log(`\n\x1b[35m[Network] 📡 -> POST Request to ${url}\x1b[0m`);
            
            if (request.postData) {
                try {
                    const payload = JSON.parse(request.postData);
                    const bytes = Buffer.byteLength(request.postData, 'utf8');
                    console.log(`\x1b[35m[Network] Payload Size: ${(bytes / 1024).toFixed(2)} KB\x1b[0m`);
                    
                    // Look for base64 images to save to disk and print stats
                    extractAndSaveImages(payload, imageCounter++);
                    
                    // Summarize payload to terminal
                    const cleanPayload = removeBase64Strings(payload);
                    console.log(`[Network] Payload Data:`, JSON.stringify(cleanPayload, null, 2));
                } catch (e) {
                    console.log(`[Network] Raw Payload: ${request.postData.substring(0, 200)}...`);
                }
            }
        }
    });

    client.on('Network.responseReceived', async params => {
        const response = params.response;
        if (response.url.includes('groq.com') || response.url.includes('openai.com') || response.url.includes('anthropic')) {
            console.log(`\x1b[32m[Network] 📥 <- Response from ${response.url} (Status: ${response.status})\x1b[0m`);
            
            try {
                const body = await client.send('Network.getResponseBody', { requestId: params.requestId });
                console.log(`[Network] Response Body:`, JSON.parse(body.body));
            } catch (err) {
                console.log(`[Network] Could not fetch response body.`);
            }
        }
    });

    // 3. Simulate Workflow using the Extension ID
    console.log('[TestRunner] Fetching Extension ID...');
    const extensionUrl = worker.url(); 
    const match = extensionUrl.match(/chrome-extension:\/\/([^\/]+)\//);
    const extensionId = match ? match[1] : null;

    if (!extensionId) {
        console.error('\x1b[31m[TestRunner] Failed to find Extension ID! Aborting.\x1b[0m');
        await browser.close();
        return;
    }

    console.log(`[TestRunner] Extension ID: ${extensionId}`);
    
    // Open a background view page to send the message safely
    const extPage = await browser.newPage();
    extPage.on('console', msg => console.log(`[ExtensionPage] ${msg.text()}`));
    
    console.log('[TestRunner] Opening extension background page to trigger pipeline...');
    await extPage.goto(`chrome-extension://${extensionId}/views/debug.html`); // Use any valid extension page
    
    // Wait for the UI to be ready
    await new Promise(r => setTimeout(r, 2000));

    console.log('[TestRunner] Firing START_AGENT_PIPELINE directly to Service Worker...');
    
    // This perfectly mimics the conversation-watcher.js sending the intercepted ChatGPT prompt
    await extPage.evaluate(() => {
        const payloadText = `\n\nUser Explicit Instruction:\ngo to parivahan.gov.in and guide me with a detailed plan`;
        console.log("Triggering message to runtime...");
        chrome.runtime.sendMessage({ 
            type: 'START_AGENT_PIPELINE', 
            payload: payloadText 
        }, (response) => {
            console.log("Response from Background:", response);
        });
    });

    console.log('\n[TestRunner] ----------------------------------------------------');
    console.log('[TestRunner] Harness is running and listening for logs. Press Ctrl+C to exit.');
    console.log('[TestRunner] ----------------------------------------------------\n');
}

// Helper functions for parsing images from JSON payloads
function extractAndSaveImages(obj, counter) {
    if (typeof obj === 'string' && obj.startsWith('data:image/')) {
        const match = obj.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
        if (match) {
            const ext = match[1];
            const base64Data = match[2];
            const buffer = Buffer.from(base64Data, 'base64');
            const filename = path.join(OUTPUT_DIR, `sent_image_${counter}.${ext}`);
            fs.writeFileSync(filename, buffer);
            
            // Log precise size in KB
            const sizeKB = (buffer.length / 1024).toFixed(2);
            console.log(`\x1b[33m[TestRunner] 📸 Extracted image (Size: ${sizeKB} KB) -> saved to: ${filename}\x1b[0m`);
        }
    } else if (Array.isArray(obj)) {
        obj.forEach((item, index) => extractAndSaveImages(item, `${counter}_${index}`));
    } else if (typeof obj === 'object' && obj !== null) {
        Object.values(obj).forEach((val, index) => extractAndSaveImages(val, `${counter}_${index}`));
    }
}

function removeBase64Strings(obj) {
    if (typeof obj === 'string' && obj.startsWith('data:image/')) {
        const sizeKB = (Buffer.from(obj.split(',')[1] || '', 'base64').length / 1024).toFixed(2);
        return `[BASE64_IMAGE_DATA_REMOVED_FOR_LOGS | Size: ${sizeKB} KB]`;
    } else if (Array.isArray(obj)) {
        return obj.map(removeBase64Strings);
    } else if (typeof obj === 'object' && obj !== null) {
        const newObj = {};
        for (const [key, value] of Object.entries(obj)) {
            newObj[key] = removeBase64Strings(value);
        }
        return newObj;
    }
    return obj;
}

runTest().catch(console.error);
