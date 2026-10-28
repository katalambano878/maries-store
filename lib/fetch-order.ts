import { supabase } from '@/lib/supabase';

/**
 * Load one order through /api/orders/<ref> (the public data API no longer
 * returns guest orders). Sends the signed-in customer's session so their own
 * orders load too. Returns null when the order can't be shown.
 */
export async function fetchOrder(
    ref: string,
    opts: { email?: string; phone?: string; tracking?: boolean } = {}
): Promise<any | null> {
    const qs = new URLSearchParams();
    if (opts.email) qs.set('email', opts.email);
    if (opts.phone) qs.set('phone', opts.phone);
    if (opts.tracking) qs.set('view', 'tracking');
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    const query = qs.toString();
    const res = await fetch(`/api/orders/${encodeURIComponent(ref)}${query ? `?${query}` : ''}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return json?.order ?? null;
}
