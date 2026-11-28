import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { checkRateLimit, getClientIdentifier, RATE_LIMITS } from '@/lib/rate-limit';
import { sendReturnRequestEmails } from '@/lib/notifications';

/**
 * POST /api/returns — a customer asks to return items from a paid order.
 * They prove the order with the email or phone used at checkout (same rule as
 * order tracking). The request is saved and the shop is emailed.
 */

const ORDER_NUMBER_RE = /^[A-Za-z0-9-]{4,64}$/;
const normalizePhone = (raw: string) => raw.replace(/\D/g, '').replace(/^233/, '').replace(/^0/, '');

export async function POST(request: Request) {
    const limit = checkRateLimit(`returns:${getClientIdentifier(request)}`, RATE_LIMITS.notification);
    if (!limit.success) {
        return NextResponse.json({ error: 'Too many requests. Try again in a minute.' }, { status: 429 });
    }

    const body = await request.json().catch(() => null);
    const orderNumber = typeof body?.orderNumber === 'string' ? body.orderNumber.trim() : '';
    const contact = typeof body?.contact === 'string' ? body.contact.trim() : '';
    const type = body?.type === 'exchange' ? 'exchange' : 'refund';
    const details = typeof body?.details === 'string' ? body.details.trim().slice(0, 2000) : '';
    const items: { orderItemId: string; quantity: number; reason: string }[] = Array.isArray(body?.items)
        ? body.items
              .filter((i: any) => typeof i?.orderItemId === 'string' && typeof i?.reason === 'string' && i.reason.trim())
              .map((i: any) => ({
                  orderItemId: i.orderItemId,
                  quantity: Math.max(1, Math.floor(Number(i.quantity) || 1)),
                  reason: String(i.reason).trim().slice(0, 200),
              }))
        : [];

    if (!ORDER_NUMBER_RE.test(orderNumber) || !contact) {
        return NextResponse.json({ error: 'Enter your order number and the email or phone you used.' }, { status: 400 });
    }
    if (items.length === 0) {
        return NextResponse.json({ error: 'Choose at least one item and a reason.' }, { status: 400 });
    }

    const { data: order } = await supabaseAdmin
        .from('orders')
        .select('id, order_number, user_id, email, phone, payment_status, shipping_address, order_items ( id, product_name, variant_name, quantity )')
        .eq('order_number', orderNumber)
        .maybeSingle();

    const row = order as any;
    const contactOk =
        !!row &&
        (String(row.email || '').toLowerCase() === contact.toLowerCase() ||
            (normalizePhone(contact).length >= 6 &&
                normalizePhone(String(row.phone || row.shipping_address?.phone || '')) === normalizePhone(contact)));
    if (!contactOk) {
        return NextResponse.json({ error: 'We could not find that order with those details.' }, { status: 404 });
    }
    if (row.payment_status !== 'paid') {
        return NextResponse.json({ error: 'Only paid orders can be returned.' }, { status: 400 });
    }

    const orderItems = new Map<string, any>((row.order_items || []).map((i: any) => [i.id, i]));
    const chosen = items.filter(i => orderItems.has(i.orderItemId));
    if (chosen.length === 0) {
        return NextResponse.json({ error: 'Those items are not on this order.' }, { status: 400 });
    }

    const requestId = crypto.randomUUID();
    const { error: requestError } = await supabaseAdmin.from('return_requests').insert({
        id: requestId,
        order_id: row.id,
        user_id: row.user_id,
        status: 'pending',
        reason: chosen.map(i => i.reason).join('; ').slice(0, 500),
        description: [type === 'exchange' ? 'Wants an exchange' : 'Wants a refund', details].filter(Boolean).join('. '),
    });
    if (requestError) {
        console.error('[returns] save failed:', requestError.message);
        return NextResponse.json({ error: 'Could not save the return request. Please try again.' }, { status: 500 });
    }

    const { error: itemsError } = await supabaseAdmin.from('return_items').insert(
        chosen.map(i => ({
            return_request_id: requestId,
            order_item_id: i.orderItemId,
            quantity: Math.min(i.quantity, Number(orderItems.get(i.orderItemId).quantity) || 1),
            reason: i.reason,
        }))
    );
    if (itemsError) console.error('[returns] items save failed:', itemsError.message);

    const shipping = row.shipping_address || {};
    await sendReturnRequestEmails({
        orderNumber: row.order_number,
        customerName: [shipping.firstName, shipping.lastName].filter(Boolean).join(' ') || shipping.full_name || '',
        email: row.email,
        phone: row.phone || shipping.phone,
        type,
        details,
        items: chosen.map(i => {
            const item = orderItems.get(i.orderItemId);
            return {
                name: [item.product_name, item.variant_name].filter(Boolean).join(' – '),
                quantity: Math.min(i.quantity, Number(item.quantity) || 1),
                reason: i.reason,
            };
        }),
    }).catch(err => console.error('[returns] email failed:', err?.message || err));

    return NextResponse.json({ success: true, id: requestId });
}
