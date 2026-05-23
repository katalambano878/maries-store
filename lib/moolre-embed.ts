/**
 * Shared Moolre API helpers (embed/link + open/transact/status).
 * Docs mention X-API-USER, X-API-PUBKEY; some accounts also require X-API-KEY (private key).
 */

export function moolreEmbedHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-API-USER': process.env.MOOLRE_API_USER || '',
        'X-API-PUBKEY': process.env.MOOLRE_API_PUBKEY || '',
    };
    const privateKey =
        process.env.MOOLRE_API_PRIVATE_KEY ||
        process.env.MOOLRE_SECRET_KEY ||
        process.env.MOOLRE_API_KEY;
    if (privateKey) {
        headers['X-API-KEY'] = privateKey;
    }
    return headers;
}

/**
 * Moolre may return major units (7) or minor (700 pesewas for GH₵ 7).
 */
export function moolreAmountsMatch(paidRaw: unknown, expectedTotal: number): boolean {
    const paid = parseFloat(String(paidRaw ?? ''));
    const expected = Number(expectedTotal);
    if (!Number.isFinite(paid) || !Number.isFinite(expected)) return false;
    if (Math.abs(paid - expected) <= 0.02) return true;
    if (Math.abs(paid / 100 - expected) <= 0.02) return true;
    if (Math.abs(paid - expected * 100) <= 1) return true;
    return false;
}

/** Avoid treating "unsuccessful" as success (substring "success"). */
export function moolreMessageImpliesSuccess(messageStr: string): boolean {
    const m = messageStr.toLowerCase();
    if (!m) return false;
    if (/unsuccess|not\s+found|failed|fail|error|declin|invalid|pending/i.test(m)) return false;
    if (/successful|transaction\s+success|payment\s+success|completed/i.test(m)) return true;
    if (/\bsuccess\b/.test(m)) return true;
    return false;
}
