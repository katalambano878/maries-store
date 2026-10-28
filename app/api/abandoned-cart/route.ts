import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { verifyAuth } from '@/lib/auth';
import { checkRateLimit, getClientIdentifier, RATE_LIMITS } from '@/lib/rate-limit';

/**
 * Checkout's abandoned-cart capture (the 09:00 cron texts carts left 1–48h).
 *
 * POST  { phone, email?, firstName, lastName, items, total, shippingAddress, cartId? }
 *       saves the shopper's cart, reusing their open cart for the same phone,
 *       and answers { id }.
 * PATCH { cartId, orderNumber }
 *       marks the cart recovered once that order exists for the same phone.
 *
 * Runs on the server because shoppers can't read abandoned carts through the
 * data API, so the browser could never find or create one (every insert asked
 * for the new row back and was refused).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normalizePhone = (raw: string) => raw.replace(/\D/g, '').replace(/^233/, '').replace(/^0/, '');
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function cleanItems(raw: unknown) {
    if (!Array.isArray(raw)) return null;
    return raw.slice(0, 50).map((it: any) => ({
        id: str(it?.id, 64),
        name: str(it?.name, 200),
        image: str(it?.image, 500),
        variant: str(it?.variant, 120) || null,
        quantity: Math.max(1, Math.min(999, Math.floor(Number(it?.quantity) || 1))),
        price: Math.max(0, Number(it?.price) || 0),
    }));
}

export async function POST(request: Request) {
    if (!checkRateLimit(`abandoned-cart:${getClientIdentifier(request)}`, RATE_LIMITS.notification).success) {
        return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }
    const body = await request.json().catch(() => null);
    const phone = str(body?.phone, 32);
    const items = cleanItems(body?.items);
    if (!phone || normalizePhone(phone).length < 7 || !items?.length) {
        return NextResponse.json({ error: 'Phone and cart items are required' }, { status: 400 });
    }

    const auth = await verifyAuth(request);
    const shipping = body?.shippingAddress && typeof body.shippingAddress === 'object' ? body.shippingAddress : null;
    const row = {
        email: str(body?.email, 254) || null,
        phone,
        first_name: str(body?.firstName, 80),
        last_name: str(body?.lastName, 80),
        cart_items: items,
        cart_total: Math.max(0, Number(body?.total) || 0),
        shipping_address: shipping,
        user_id: auth.authenticated ? auth.user.id : null,
    };

    // Reuse this shopper's open cart: the one checkout already made, or the
    // latest unrecovered cart for the same phone in the reminder window.
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    let existingId: string | null = null;
    const cartId = str(body?.cartId, 36);
    const { data: candidates } = await supabaseAdmin
        .from('abandoned_carts')
        .select('id, phone')
        .eq('recovered', false)
        .gt('created_at', since)
        .order('created_at', { ascending: false })
        .limit(50);
    const samePhone = (candidates || []).filter((c: any) => normalizePhone(c.phone || '') === normalizePhone(phone));
    existingId = (UUID_RE.test(cartId) && samePhone.find((c: any) => c.id === cartId)?.id) || samePhone[0]?.id || null;

    if (existingId) {
        const { error } = await supabaseAdmin
            .from('abandoned_carts')
            .update({ ...row, updated_at: new Date().toISOString() })
            .eq('id', existingId);
        if (error) return NextResponse.json({ error: 'Could not save cart' }, { status: 500 });
        return NextResponse.json({ id: existingId });
    }

    const { data, error } = await supabaseAdmin.from('abandoned_carts').insert(row).select('id').single();
    if (error || !data) {
        console.error('[abandoned-cart] insert failed:', error?.message);
        return NextResponse.json({ error: 'Could not save cart' }, { status: 500 });
    }
    return NextResponse.json({ id: data.id });
}

export async function PATCH(request: Request) {
    if (!checkRateLimit(`abandoned-cart:${getClientIdentifier(request)}`, RATE_LIMITS.notification).success) {
        return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }
    const body = await request.json().catch(() => null);
    const cartId = str(body?.cartId, 36);
    const orderNumber = str(body?.orderNumber, 64);
    if (!UUID_RE.test(cartId) || !orderNumber) {
        return NextResponse.json({ error: 'cartId and orderNumber are required' }, { status: 400 });
    }

    const [{ data: cart }, { data: order }] = await Promise.all([
        supabaseAdmin.from('abandoned_carts').select('id, phone, recovered').eq('id', cartId).maybeSingle(),
        supabaseAdmin.from('orders').select('id, phone').eq('order_number', orderNumber).maybeSingle(),
    ]);
    // Only the shopper who placed that order can close their cart.
    if (!cart || !order || normalizePhone(String((cart as any).phone || '')) !== normalizePhone(String((order as any).phone || ''))) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (!(cart as any).recovered) {
        await supabaseAdmin
            .from('abandoned_carts')
            .update({ recovered: true, recovered_at: new Date().toISOString() })
            .eq('id', cartId);
    }
    return NextResponse.json({ success: true });
}
