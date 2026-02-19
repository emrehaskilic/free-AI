import { timingSafeEqual } from 'crypto';
import { IncomingMessage } from 'http';
import { NextFunction, Request, Response } from 'express';

const API_KEY_SECRET = String(process.env.API_KEY_SECRET || '').trim();
if (!API_KEY_SECRET) {
    throw new Error('[auth] Missing API_KEY_SECRET. Set it in server/.env before starting the backend.');
}

const ALLOW_LOCALHOST_NO_AUTH = !['false', '0', 'no'].includes(
    String(process.env.ALLOW_LOCALHOST_NO_AUTH || 'true').toLowerCase()
);
const ALLOW_PUBLIC_MARKET_DATA = !['false', '0', 'no'].includes(
    String(process.env.ALLOW_PUBLIC_MARKET_DATA || 'true').toLowerCase()
);
const PUBLIC_GET_PATHS = new Set<string>([
    '/exchange-info',
    '/testnet/exchange-info',
    '/dry-run/symbols',
    '/dry-run/status',
]);

function isLocalAddress(raw?: string): boolean {
    if (!raw) return false;
    const addr = raw.trim().toLowerCase();
    if (addr === '127.0.0.1' || addr === '::1') return true;
    if (addr.startsWith('::ffff:')) {
        const v4 = addr.slice('::ffff:'.length);
        return v4 === '127.0.0.1';
    }
    return false;
}

function isLocalRequest(req: IncomingMessage): boolean {
    if (!ALLOW_LOCALHOST_NO_AUTH) return false;
    return isLocalAddress(req.socket?.remoteAddress);
}

function isPublicMarketDataRequest(req: Request): boolean {
    if (!ALLOW_PUBLIC_MARKET_DATA) return false;
    if (req.method !== 'GET') return false;
    return PUBLIC_GET_PATHS.has(req.path);
}

function safeEquals(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) {
        return false;
    }
    return timingSafeEqual(left, right);
}

function getApiKeyFromAuthorization(headers: IncomingMessage['headers']): string {
    const authRaw = headers.authorization;
    const auth = Array.isArray(authRaw) ? String(authRaw[0] || '') : String(authRaw || '');
    const [scheme, token] = auth.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && token) {
        return token.trim();
    }
    return '';
}

function decodeBase64UrlToken(value: string): string {
    try {
        return Buffer.from(value, 'base64url').toString('utf8').trim();
    } catch {
        return '';
    }
}

function getApiKeyFromWebSocketProtocol(headers: IncomingMessage['headers']): string {
    const raw = headers['sec-websocket-protocol'];
    const protocolHeader = Array.isArray(raw)
        ? raw.map((value) => String(value || '')).join(',')
        : String(raw || '');
    if (!protocolHeader) {
        return '';
    }

    const protocols = protocolHeader.split(',').map((p) => p.trim()).filter(Boolean);
    const bearerProtocol = protocols.find((p) => p.startsWith('bearer.'));
    if (!bearerProtocol) {
        return '';
    }

    return decodeBase64UrlToken(bearerProtocol.slice('bearer.'.length));
}

function extractApiKey(req: IncomingMessage): string {
    return getApiKeyFromAuthorization(req.headers) || getApiKeyFromWebSocketProtocol(req.headers);
}

export function isApiKeyValid(apiKey: string): boolean {
    if (!apiKey) {
        return false;
    }
    return safeEquals(apiKey, API_KEY_SECRET);
}

export function apiKeyMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (isLocalRequest(req) || isPublicMarketDataRequest(req)) {
        next();
        return;
    }
    const apiKey = extractApiKey(req);
    if (!isApiKeyValid(apiKey)) {
        res.status(401).json({
            ok: false,
            error: 'unauthorized',
            message: 'Provide a valid bearer token in the Authorization header.',
        });
        return;
    }
    next();
}

export function validateWebSocketApiKey(req: IncomingMessage): { ok: boolean; reason?: string } {
    if (isLocalRequest(req) || ALLOW_PUBLIC_MARKET_DATA) {
        return { ok: true };
    }
    const apiKey = extractApiKey(req);
    if (!isApiKeyValid(apiKey)) {
        return { ok: false, reason: 'invalid_api_key' };
    }
    return { ok: true };
}
