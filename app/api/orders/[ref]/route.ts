import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { verifyAuth } from '@/lib/auth';
import { checkRateLimit, getClientIdentifier, RATE_LIMITS } from '@/lib/rate-limit';

/**
 * One order for the storefront's order-success, pay and order-tracking pages.
 *
 * GET /api/orders/<order number or id>
 *   ?email=…|&phone=…   contact used at checkout (required with ?view=tracking)
 *   ?view=tracking      adds product images to the items
 *
 * Guest orders are shown to whoever holds the exact order number or id (the
 * link in the payment redirect and emails), or to anyone who proves the
 * checkout email/phone. Orders placed while signed in also need that
 * customer's session (or staff). Nothing here lists orders: before this
 * route, the public data API returned every guest order to anyone.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_NUMBER_RE = /^[A-Za-z0-9-]{4,64}$/;

const normalizePhone = (raw: string) => raw.replace(/\D/g, '').replace(/^233/, '').replace(/^0/, '');

export async function GET(request: Request, { params }: { params: Promise<{ ref: string }> }) {
    const limit = checkRateLimit(`order-lookup:${getClientIdentifier(request)}`, RATE_LIMITS.orderLookup);
    if (!limit.success) {
        return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: NO_STORE });
    }

    const { ref } = await params;
    if (!ref || !(UUID_RE.test(ref) || ORDER_NUMBER_RE.test(ref))) {
        return NextResponse.json({ error: 'Order not found' }, { status: 404, headers: NO_STORE });
    }

    const url = new URL(request.url);
    const tracking = url.searchParams.get('view') === 'tracking';
    const email = (url.searchParams.get('email') || '').trim().toLowerCase();
    const phone = (url.searchParams.get('phone') || '').trim();

    const select = tracking
        ? '*, order_items ( id, product_name, variant_name, quantity, unit_price, total_price, metadata, products ( product_images (url) ) )'
        : '*, order_items (*)';
    const { data: order, error } = await supabaseAdmin
        .from('orders')
        .select(select)
        .eq(UUID_RE.test(ref) ? 'id' : 'order_number', ref)
        .maybeSingle();

    if (error) {
        console.error('[orders] lookup failed:', error.message);
        return NextResponse.json({ error: 'Could not load the order' }, { status: 500, headers: NO_STORE });
    }
    // Same answer for "no such order" and "not yours", so numbers can't be probed.
    const notFound = () => NextResponse.json({ error: 'Order not found' }, { status: 404, headers: NO_STORE });
    if (!order) return notFound();
    const row = order as any;

    const contactOk =
        (!!email && String(row.email || '').toLowerCase() === email) ||
        (!!phone && normalizePhone(String(row.phone || row.shipping_address?.phone || '')) === normalizePhone(phone));

    if (tracking && !contactOk) return notFound();

    if (row.user_id && !contactOk) {
        const auth = await verifyAuth(request);
        const isOwner = auth.authenticated && auth.user?.id === row.user_id;
        const isStaff = auth.authenticated && (await verifyAuth(request, { requireAdmin: true })).authenticated;
        if (!isOwner && !isStaff) return notFound();
    }

    const { user_id: _userId, ...publicOrder } = row;
    return NextResponse.json({ order: publicOrder }, { headers: NO_STORE });
}
