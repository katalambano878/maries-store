import { NextResponse } from 'next/server';
import { checkRateLimit, getClientIdentifier, RATE_LIMITS } from '@/lib/rate-limit';
import { confirmHubtelPaymentFromStatus } from '@/lib/hubtel-payment-confirm';
import { supabaseAdmin } from '@/lib/supabase-admin';

function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, '');
  if (appUrl && origin === appUrl) return true;

  try {
    const originHost = new URL(origin).host;
    const host = req.headers.get('host');
    if (host && originHost === host) return true;
    if (appUrl) {
      const appHost = new URL(appUrl).host;
      if (originHost === appHost) return true;
    }
  } catch {
    return false;
  }

  return false;
}

export async function POST(req: Request) {
  try {
    const clientId = getClientIdentifier(req);
    const rateLimitResult = checkRateLimit(`verify:hubtel:${clientId}`, RATE_LIMITS.payment);
    if (!rateLimitResult.success) {
      return NextResponse.json({ success: false, message: 'Too many requests' }, { status: 429 });
    }

    if (!isSameOrigin(req)) {
      return NextResponse.json({ success: false, message: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json();
    const orderNumber = typeof body.orderNumber === 'string' ? body.orderNumber.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

    if (!orderNumber || !/^ORD-\d+-\d+$/.test(orderNumber)) {
      return NextResponse.json({ success: false, message: 'Invalid order number format' }, { status: 400 });
    }

    if (!email || !/\S+@\S+\.\S+/.test(email)) {
      return NextResponse.json({ success: false, message: 'Valid email is required' }, { status: 400 });
    }

    console.log('[Hubtel Verify] order:', orderNumber);

    const { data: order, error: fetchError } = await supabaseAdmin
      .from('orders')
      .select('id, order_number, payment_status, status, total, email, metadata')
      .eq('order_number', orderNumber)
      .single();

    if (fetchError || !order) {
      return NextResponse.json({ success: false, message: 'Order not found' }, { status: 404 });
    }

    const orderEmail = (order.email || '').trim().toLowerCase();
    if (!orderEmail || orderEmail !== email) {
      return NextResponse.json({ success: false, message: 'Order not found' }, { status: 404 });
    }

    if (order.payment_status === 'paid') {
      return NextResponse.json({
        success: true,
        status: order.status,
        payment_status: order.payment_status,
        message: 'Order already paid',
      });
    }

    const meta = (order.metadata || {}) as Record<string, unknown>;
    const clientReference = meta.hubtel_client_reference as string | undefined;
    if (!clientReference) {
      return NextResponse.json({
        success: false,
        message: 'No Hubtel checkout session found for this order',
      }, { status: 400 });
    }

    const hubtelRef =
      (meta.hubtel_checkout_id as string) || clientReference;

    const result = await confirmHubtelPaymentFromStatus(orderNumber, clientReference, hubtelRef);

    if (!result.success) {
      return NextResponse.json({
        success: false,
        status: order.status,
        payment_status: order.payment_status,
        message: result.message || 'Payment not verified by Hubtel',
      });
    }

    return NextResponse.json({
      success: true,
      status: 'processing',
      payment_status: 'paid',
      message: 'Payment verified and order updated',
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[Hubtel Verify] Error:', msg);
    return NextResponse.json({ success: false, message: 'Internal error' }, { status: 500 });
  }
}
