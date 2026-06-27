import { NextResponse } from 'next/server';
import { checkRateLimit, getClientIdentifier, RATE_LIMITS } from '@/lib/rate-limit';
import { prepareOrderForPayment } from '@/lib/payment-order-prep';
import {
  hubtelInitiateCheckout,
  isHubtelConfigured,
  makeHubtelClientReference,
  normalizeGhPhone,
} from '@/lib/hubtel';
import { supabaseAdmin } from '@/lib/supabase-admin';

function appBaseUrl(req: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured && /^https?:\/\//i.test(configured)) {
    return configured.replace(/\/+$/, '');
  }
  const requestUrl = new URL(req.url);
  return requestUrl.origin.replace(/\/+$/, '');
}

export async function POST(req: Request) {
  try {
    const clientId = getClientIdentifier(req);
    const rateLimitResult = checkRateLimit(`payment:hubtel:${clientId}`, RATE_LIMITS.payment);
    if (!rateLimitResult.success) {
      return NextResponse.json(
        { success: false, message: 'Too many requests. Please try again later.' },
        { status: 429 }
      );
    }

    if (!isHubtelConfigured()) {
      return NextResponse.json(
        { success: false, message: 'Hubtel payment gateway is not configured' },
        { status: 500 }
      );
    }

    const body = await req.json();
    const orderId = body.orderId as string | undefined;
    const customerEmail = typeof body.customerEmail === 'string' ? body.customerEmail.trim() : undefined;
    const redirectUrl = typeof body.redirectUrl === 'string' ? body.redirectUrl.trim() : undefined;

    if (!orderId || typeof orderId !== 'string') {
      return NextResponse.json({ success: false, message: 'Missing or invalid orderId' }, { status: 400 });
    }

    const prep = await prepareOrderForPayment(orderId);
    if ('error' in prep) {
      const payload: Record<string, unknown> = { success: false, message: prep.error };
      if (prep.status === 409) payload.all_out_of_stock = true;
      return NextResponse.json(payload, { status: prep.status });
    }

    const { order, removedItems } = prep;
    const orderNumber = String(order.order_number);
    const amount = Math.round(Number(order.total) * 100) / 100;

    if (!amount || amount <= 0) {
      return NextResponse.json({ success: false, message: 'Invalid order amount' }, { status: 400 });
    }

    const baseUrl = appBaseUrl(req);
    const clientReference = makeHubtelClientReference(orderNumber);

    const safeRedirect =
      redirectUrl && redirectUrl.startsWith('https://') ? redirectUrl : null;
    const returnUrl =
      safeRedirect ??
      `${baseUrl}/order-success?order=${encodeURIComponent(orderNumber)}&payment_success=true&gateway=hubtel`;
    const callbackUrl = `${baseUrl}/api/payment/hubtel/callback`;
    const cancellationUrl = `${baseUrl}/pay/${encodeURIComponent(orderNumber)}?cancelled=true`;

    const shipping = (order.shipping_address || {}) as Record<string, string>;
    const meta = (order.metadata || {}) as Record<string, string>;
    const firstName = meta.first_name || shipping.firstName || '';
    const lastName = meta.last_name || shipping.lastName || '';
    const payeeName = `${firstName} ${lastName}`.trim() || undefined;
    const payeeEmail = (customerEmail || (order.email as string) || shipping.email || '').trim() || undefined;
    const payeePhone = normalizeGhPhone((order.phone as string) || shipping.phone);

    console.log(
      '[Hubtel Init] order:',
      orderNumber,
      '| amount:',
      amount,
      '| clientRef:',
      clientReference
    );

    const result = await hubtelInitiateCheckout({
      totalAmount: amount,
      description: `Order ${orderNumber}`,
      callbackUrl,
      returnUrl,
      cancellationUrl,
      clientReference,
      payeeName,
      payeeEmail,
      payeeMobileNumber: payeePhone || undefined,
    });

    const checkoutUrl = result.checkoutUrl || result.checkoutDirectUrl;
    if (!checkoutUrl) {
      console.error('[Hubtel Init] No checkout URL — upstream:', result.message, result.raw);
      return NextResponse.json(
        {
          success: false,
          message: result.message || 'Hubtel did not return a checkout URL',
        },
        { status: 502 }
      );
    }

    const existingMeta =
      order.metadata && typeof order.metadata === 'object' && !Array.isArray(order.metadata)
        ? (order.metadata as Record<string, unknown>)
        : {};

    await supabaseAdmin
      .from('orders')
      .update({
        metadata: {
          ...existingMeta,
          payment_gateway: 'hubtel',
          hubtel_client_reference: clientReference,
          hubtel_checkout_id: result.checkoutId,
          hubtel_initiated_at: new Date().toISOString(),
        },
      })
      .eq('id', order.id);

    console.log('[Hubtel Init] checkout ready — order:', orderNumber, '| checkoutId:', result.checkoutId);

    return NextResponse.json({
      success: true,
      url: checkoutUrl,
      checkoutId: result.checkoutId,
      externalRef: clientReference,
      amount,
      removedItems,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[Hubtel Init] Error:', msg);
    return NextResponse.json({ success: false, message: 'Internal Server Error' }, { status: 500 });
  }
}
