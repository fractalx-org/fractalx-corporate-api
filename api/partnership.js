/**
 * FractalX Corporate Partnership API
 * Vercel Serverless Function — POST /api/partnership
 *
 * Spam defences:
 *   1. Origin allowlist (ALLOWED_ORIGINS env var)
 *   2. Honeypot field (website) — bots fill it, humans don't
 *   3. IP-based rate limiting (3 submissions per 15 min per IP)
 *   4. Input validation (required fields, email format, max lengths)
 *
 * Notifications (configure at least one):
 *   - WEBHOOK_URL  → Discord / Slack incoming webhook
 *   - RESEND_API_KEY + NOTIFICATION_EMAIL → email via Resend (resend.com)
 *   - RESEND_FROM  → sender address (default: noreply@fractalx.org)
 *
 * If neither is configured, submissions are logged to stdout (visible in
 * Vercel function logs) and still return 200 — useful during development.
 */

// ── In-memory rate-limit store ───────────────────────────────────────────────
// NOTE: This resets on cold starts. For high-traffic production use, replace
// with Upstash Redis: https://docs.upstash.com/redis/sdks/ts/overview
const rateMap = new Map(); // ip -> { count, windowStart }
const RATE_LIMIT = 3;                    // max submissions per window
const RATE_WINDOW_MS = 15 * 60 * 1000;  // 15 minutes

function checkRateLimit(ip) {
    const now = Date.now();
    const entry = rateMap.get(ip);

    if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
        rateMap.set(ip, { count: 1, windowStart: now });
        return { allowed: true };
    }

    if (entry.count >= RATE_LIMIT) {
        const retryAfterMs = RATE_WINDOW_MS - (now - entry.windowStart);
        return { allowed: false, retryAfterMs };
    }

    entry.count++;
    return { allowed: true };
}

// ── CORS helper ──────────────────────────────────────────────────────────────
function setCorsHeaders(req, res) {
    const origin = req.headers.origin || '';
    const raw = process.env.ALLOWED_ORIGINS || 'https://fractalx.org';
    const allowed = raw.split(',').map(o => o.trim());

    if (allowed.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }

    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
}

// ── Notification: Discord / Slack webhook ────────────────────────────────────
async function notifyWebhook(data) {
    const url = process.env.WEBHOOK_URL;
    if (!url) return;

    const isSlack = url.includes('hooks.slack.com');

    const text = isSlack
        ? [
            '*🎉 New Enterprise Waitlist Signup — FractalX*',
            `*Email:* ${data.email}`,
            `*Name:* ${data.name || '—'}`,
            `*Company:* ${data.company || '—'}`,
            `*Team size:* ${data.size || '—'}`,
        ].join('\n')
        : [
            '**🎉 New Enterprise Waitlist Signup — FractalX**',
            `**Email:** ${data.email}`,
            `**Name:** ${data.name || '—'}`,
            `**Company:** ${data.company || '—'}`,
            `**Team size:** ${data.size || '—'}`,
        ].join('\n');

    const body = isSlack ? { text } : { content: text };

    await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

// ── Notification: Resend email ───────────────────────────────────────────────
async function notifyEmail(data) {
    const apiKey = process.env.RESEND_API_KEY;
    const to = process.env.NOTIFICATION_EMAIL;
    if (!apiKey || !to) return;

    const from = process.env.RESEND_FROM || 'FractalX <noreply@fractalx.org>';

    const html = `
<h2 style="font-family:sans-serif;margin-bottom:16px">New Enterprise Waitlist Signup</h2>
<table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">
  <tr><td style="padding:6px 12px 6px 0;color:#666;white-space:nowrap">Email</td><td style="padding:6px 0"><strong>${escapeHtml(data.email)}</strong></td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#666;white-space:nowrap">Name</td><td style="padding:6px 0">${escapeHtml(data.name || '—')}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#666;white-space:nowrap">Company</td><td style="padding:6px 0">${escapeHtml(data.company || '—')}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#666;white-space:nowrap">Team size</td><td style="padding:6px 0">${escapeHtml(data.size || '—')}</td></tr>
</table>
`.trim();

    await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from,
            to: [to],
            subject: `[FractalX] New waitlist signup — ${data.email}`,
            html,
        }),
    });
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    setCorsHeaders(req, res);

    // Pre-flight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Content-type guard
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('application/json')) {
        return res.status(415).json({ error: 'Content-Type must be application/json' });
    }

    // Rate limiting
    const ip =
        (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.socket?.remoteAddress ||
        'unknown';

    const rl = checkRateLimit(ip);
    if (!rl.allowed) {
        const retryAfterSec = Math.ceil(rl.retryAfterMs / 1000);
        res.setHeader('Retry-After', String(retryAfterSec));
        return res.status(429).json({
            error: 'Too many requests. Please wait a while before trying again.',
        });
    }

    // Parse body
    const { name, company, email, size, website } = req.body || {};

    // Honeypot — return a silent 200 to not tip off bots
    if (website) {
        return res.status(200).json({ success: true });
    }

    // Validation — only email is required
    if (!email?.trim()) {
        return res.status(400).json({ error: 'Email is required.' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    if (email.trim().length > 200) {
        return res.status(400).json({ error: 'Email must be 200 characters or fewer.' });
    }
    if (name && name.length > 100) {
        return res.status(400).json({ error: 'Name must be 100 characters or fewer.' });
    }
    if (company && company.length > 100) {
        return res.status(400).json({ error: 'Company must be 100 characters or fewer.' });
    }

    const clean = {
        email: email.trim().toLowerCase(),
        name: (name || '').trim(),
        company: (company || '').trim(),
        size: (size || '').trim(),
    };

    // Log for Vercel function logs (always useful)
    console.log('[waitlist] New signup', {
        email: clean.email,
        name: clean.name,
        company: clean.company,
        size: clean.size,
        ip,
    });

    // Send notifications — don't let notification failures break the response
    const notifications = [notifyWebhook(clean), notifyEmail(clean)];
    const results = await Promise.allSettled(notifications);

    results.forEach((r, i) => {
        if (r.status === 'rejected') {
            console.error(`[partnership] Notification[${i}] failed:`, r.reason);
        }
    });

    return res.status(200).json({ success: true });
}
