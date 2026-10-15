const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3005;
const OUTPUT_DIR = path.resolve(__dirname, 'output');

if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const LOG_FILE = path.resolve(OUTPUT_DIR, 'telemetry.log');
fs.writeFileSync(LOG_FILE, '--- Telemetry Server Started ---\n');

const originalLog = console.log;
console.log = function(...args) {
    originalLog.apply(console, args);
    // Strip ANSI color codes for cleaner text log
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ').replace(/\x1b\[[0-9;]*m/g, '');
    fs.appendFileSync(LOG_FILE, msg + '\n');
};

let imageCounter = 1;

function processPayload(payload) {
    if (payload.type === 'log') {
        const color = payload.level === 'error' ? '\x1b[31m' : (payload.level === 'warn' ? '\x1b[33m' : '\x1b[36m');
        console.log(`${color}[${payload.context}:${payload.level}] ${payload.message}\x1b[0m`);
    } else if (payload.type === 'network') {
        if (payload.event === 'request') {
            console.log(`\n\x1b[35m[Network:${payload.context}] 📡 -> POST Request to ${payload.url}\x1b[0m`);
            if (payload.body) {
                try {
                    const parsed = typeof payload.body === 'string' ? JSON.parse(payload.body) : payload.body;
                    const bytes = typeof payload.body === 'string' ? Buffer.byteLength(payload.body, 'utf8') : JSON.stringify(payload.body).length;
                    console.log(`\x1b[35m[Network] Payload Size: ${(bytes / 1024).toFixed(2)} KB\x1b[0m`);
                    
                    extractAndSaveImages(parsed, imageCounter++);
                    const cleanPayload = removeBase64Strings(parsed);
                    console.log(`[Network] Payload Data:`, JSON.stringify(cleanPayload, null, 2));
                } catch (e) {
                    console.log(`[Network] Raw Payload:`, typeof payload.body === 'string' ? payload.body.substring(0, 200) + '...' : payload.body);
                }
            }
        } else if (payload.event === 'response') {
            console.log(`\x1b[32m[Network:${payload.context}] 📥 <- Response from ${payload.url} (Status: ${payload.status})\x1b[0m`);
            if (payload.body) {
                try {
                    const parsed = typeof payload.body === 'string' ? JSON.parse(payload.body) : payload.body;
                    console.log(`[Network] Response Body:`, JSON.stringify(parsed, null, 2));
                } catch(e) {
                    console.log(`[Network] Raw Response:`, typeof payload.body === 'string' ? payload.body.substring(0, 200) + '...' : payload.body);
                }
            }
        }
    }
}

function extractAndSaveImages(obj, counter) {
    if (typeof obj === 'string' && obj.startsWith('data:image/')) {
        const match = obj.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
        if (match) {
            const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
            const base64Data = match[2];
            const buffer = Buffer.from(base64Data, 'base64');
            const filename = path.join(OUTPUT_DIR, `live_image_${counter}.${ext}`);
            fs.writeFileSync(filename, buffer);
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

const server = http.createServer((req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
        return;
    }

    if (req.method === 'POST' && req.url === '/log') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const payload = JSON.parse(body);
                processPayload(payload);
                res.writeHead(200, {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': 'application/json'
                });
                res.end(JSON.stringify({ status: 'ok' }));
            } catch (err) {
                res.writeHead(400, {
                    'Access-Control-Allow-Origin': '*'
                });
                res.end('Bad Request');
            }
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 Live Telemetry Server running on http://localhost:${PORT}`);
    console.log(`Waiting for extension logs...`);
    console.log(`======================================================\n`);
});
