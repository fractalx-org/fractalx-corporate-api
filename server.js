/**
 * Local development server — wraps the Vercel handlers with a plain Node HTTP server.
 * Usage: node server.js  (or npm start)
 * Vercel deployment is unaffected; this file is ignored by Vercel.
 */
import http from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load .env before handlers read process.env
const __dir = dirname(fileURLToPath(import.meta.url));
try {
    const lines = readFileSync(join(__dir, '.env'), 'utf8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        if (key && !(key in process.env)) process.env[key] = val;
    }
} catch { /* no .env file — rely on shell env vars */ }

const { default: partnershipHandler } = await import('./api/partnership.js');
const { default: certificateHandler  } = await import('./api/certificate.js');

// Route table: path prefix → handler
const routes = {
    '/api/partnership': partnershipHandler,
    '/api/certificate':  certificateHandler,
};

const PORT = process.env.PORT || 3000;

/** Wraps Node's ServerResponse to match the Vercel res API */
function buildRes(nodeRes) {
    let code = 200;
    const wrapper = {
        status(c)         { code = c; return wrapper; },
        setHeader(k, v)   { nodeRes.setHeader(k, v); return wrapper; },
        end()             { nodeRes.writeHead(code); nodeRes.end(); },
        json(data)        {
            nodeRes.writeHead(code, { 'Content-Type': 'application/json' });
            nodeRes.end(JSON.stringify(data));
        },
    };
    return wrapper;
}

/** Reads and JSON-parses the request body (for POST/PATCH handlers) */
function readBody(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            try { resolve(raw ? JSON.parse(raw) : {}); }
            catch { resolve({}); }
        });
        req.on('error', reject);
    });
}

const server = http.createServer(async (req, res) => {
    // Match path (strip query string for routing)
    const path = (req.url || '').split('?')[0];
    const handler = routes[path];

    if (!handler) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
    }

    // Only parse body for methods that carry one
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
        req.body = await readBody(req);
    }

    await handler(req, buildRes(res));
});

server.listen(PORT, () => {
    console.log(`Local server →  http://localhost:${PORT}`);
    console.log(`Endpoints:`);
    console.log(`  POST http://localhost:${PORT}/api/partnership`);
    console.log(`  GET  http://localhost:${PORT}/api/certificate?event=sliit-dev-conf-26&email=...`);
    console.log(`  GET  http://localhost:${PORT}/api/certificate?event=sliit-dev-conf-26&mobile=...`);
    console.log(`  GET  http://localhost:${PORT}/api/certificate?event=sliit-dev-conf-26&verify=...`);
});
