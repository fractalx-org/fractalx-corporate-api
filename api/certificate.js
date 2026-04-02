/**
 * FractalX Certificate API
 * Vercel Serverless Function — GET /api/certificate
 *
 * Reads participant records from MongoDB (database: events, collection: certificates).
 *
 * Query parameters:
 *   event   — event slug, e.g. "sliit-dev-conf-26" (required)
 *   email   — registered email address
 *   mobile  — registered mobile number (any format; last 9 digits matched)
 *   verify  — 16-char hex certificate ID to verify
 *
 * Environment variables:
 *   MONGODB_URI      — MongoDB connection string (required)
 *   ALLOWED_ORIGINS  — comma-separated frontend origins for CORS
 *
 * MongoDB document shape (collection: certificates):
 *   { event: "sliit-dev-conf-26", name: "Jane Doe", email: "jane@example.com", mobile: "0712345678" }
 *
 * Recommended indexes (create once in Atlas):
 *   { event: 1, email: 1 }  — unique
 *   { event: 1, mobile: 1 }
 *
 * To add a new event:
 *   1. Add an entry to EVENTS below.
 *   2. Insert documents into the certificates collection with the new event slug.
 */

import { MongoClient } from 'mongodb';
import { createHash } from 'crypto';

// ── Event registry ────────────────────────────────────────────────────────────
const EVENTS = {
    'sliit-dev-conf-26': {
        title:    'Introduction to Microservices & FractalX Framework',
        subtitle: 'SLIIT Dev Conf 2026',
        date:     'Saturday, 4th April 2026',
        time:     '1:30 PM – 3:30 PM',
        venue:    'Hall F1402, SLIIT',
        issuedBy: 'FractalX & SESC',
        type:     'participation',
    },
    // Add future events here, e.g.:
    // 'fractalx-workshop-q3-26': {
    //     title:    'Advanced Microservices with FractalX',
    //     subtitle: 'FractalX Workshop Q3 2026',
    //     date:     '15th August 2026',
    //     time:     '10:00 AM – 4:00 PM',
    //     venue:    'Colombo Tech Hub',
    //     issuedBy: 'FractalX',
    //     type:     'skill',
    // },
};

// ── MongoDB connection (cached across warm serverless invocations) ────────────
let cachedClient = null;

async function getCollection() {
    if (!cachedClient) {
        const uri = process.env.MONGODB_URI;
        if (!uri) throw new Error('MONGODB_URI environment variable is not set.');
        cachedClient = new MongoClient(uri, {
            maxPoolSize: 5,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 10000,
        });
        await cachedClient.connect();
    }
    return cachedClient.db('events').collection('certificates');
}

// ── Certificate ID (deterministic, stateless) ─────────────────────────────────
function buildCertId(eventSlug, email) {
    return createHash('sha256')
        .update(`${eventSlug}:${email.trim().toLowerCase()}`)
        .digest('hex')
        .slice(0, 16);
}

// ── Mobile normalisation (last 9 digits; handles +94 / 0 prefix / spaces) ────
function normMobile(m) {
    return (m || '').replace(/\D/g, '').slice(-9);
}

// ── In-memory rate limiting ────────────────────────────────────────────────────
const rateMap = new Map();
const RATE_LIMIT    = 10;
const RATE_WINDOW   = 15 * 60 * 1000;

function checkRateLimit(ip) {
    const now   = Date.now();
    const entry = rateMap.get(ip);
    if (!entry || now - entry.windowStart >= RATE_WINDOW) {
        rateMap.set(ip, { count: 1, windowStart: now });
        return true;
    }
    if (entry.count >= RATE_LIMIT) return false;
    entry.count++;
    return true;
}

// ── CORS ──────────────────────────────────────────────────────────────────────
function setCors(req, res) {
    const origin  = req.headers.origin || '';
    const allowed = (process.env.ALLOWED_ORIGINS || 'https://fractalx.org')
        .split(',').map(o => o.trim());
    if (allowed.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
}

// ── Query string helper (Vercel provides req.query; plain Node HTTP doesn't) ──
function getQuery(req) {
    if (req.query) return req.query;
    const qs = (req.url || '').includes('?')
        ? req.url.slice(req.url.indexOf('?') + 1)
        : '';
    return Object.fromEntries(new URLSearchParams(qs));
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    setCors(req, res);

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || req.socket?.remoteAddress
        || 'unknown';

    if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    const { event, email, mobile, verify } = getQuery(req);

    if (!event || !EVENTS[event]) {
        return res.status(404).json({ error: 'Event not found.' });
    }

    const eventMeta = EVENTS[event];

    let col;
    try {
        col = await getCollection();
    } catch (err) {
        console.error('[certificate] DB connection failed:', err.message);
        return res.status(503).json({ error: 'Service temporarily unavailable. Please try again shortly.' });
    }

    // ── Verify by certificate ID ──────────────────────────────────────────────
    if (verify) {
        // Fetch all docs for this event and find whose derived ID matches.
        // (Avoids storing certId in DB; keeps it purely deterministic.)
        const cursor = col.find({ event }, { projection: { name: 1, email: 1 } });
        let found = null;
        for await (const doc of cursor) {
            if (doc.email && buildCertId(event, doc.email) === verify) {
                found = doc;
                break;
            }
        }
        if (!found) {
            return res.status(404).json({ valid: false, error: 'Certificate not found.' });
        }
        return res.status(200).json({ valid: true, name: found.name, certificateId: verify, event: eventMeta });
    }

    // ── Lookup by email ───────────────────────────────────────────────────────
    if (email) {
        const norm = email.trim().toLowerCase();
        const doc  = await col.findOne(
            { event, email: { $regex: `^${escapeRegex(norm)}$`, $options: 'i' } },
            { projection: { name: 1, email: 1 } }
        );
        if (!doc) {
            return res.status(404).json({ found: false, error: 'No certificate found for this email address.' });
        }
        return res.status(200).json({
            found:         true,
            name:          doc.name,
            certificateId: buildCertId(event, doc.email),
            event:         eventMeta,
        });
    }

    // ── Lookup by mobile ──────────────────────────────────────────────────────
    if (mobile) {
        const norm = normMobile(mobile);
        if (norm.length < 7) {
            return res.status(400).json({ error: 'Please enter a valid mobile number.' });
        }
        // Fetch candidates and normalise in JS (mobile formats vary in stored data)
        const candidates = await col
            .find({ event }, { projection: { name: 1, email: 1, mobile: 1 } })
            .toArray();
        const doc = candidates.find(d => normMobile(d.mobile) === norm);
        if (!doc) {
            return res.status(404).json({ found: false, error: 'No certificate found for this mobile number.' });
        }
        return res.status(200).json({
            found:         true,
            name:          doc.name,
            certificateId: buildCertId(event, doc.email),
            event:         eventMeta,
        });
    }

    return res.status(400).json({ error: 'Provide email, mobile, or verify parameter.' });
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
