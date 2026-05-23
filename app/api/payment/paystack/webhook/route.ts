import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { sendOrderConfirmation } from '@/lib/notifications';
import { checkRateLimit, getClientIdentifier, RATE_LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Paystack Webhook
 * ------------------------------------------------------------
 * Paystack sends POST requests to this endpoint for transaction
 * events. The request is signed using HMAC SHA512 over the raw
 * body with your PAYSTACK_SECRET_KEY, sent as `x-paystack-signature`.
 *
 * Events handled:
 *   - charge.success  -> mark order as paid (idempotent)
 *   - charge.failed   -> mark order payment_status = failed
 *
 * Whitelist this URL in the Paystack Dashboard:
 *   https://shopmarieshair.com/api/payment/paystack/webhook
 */
export async function POST(req: Request) {
  console.log('[Paystack Webhook] POST received at', new Date().toISOString());

  try {
    const clientId = getClientIdentifier(req);
    const rateLimitResult = checkRateLimit(`webhook:paystack:${clientId}`, RATE_LIMITS.callback);
    if (!rateLimitResult.success) {
      console.warn('[Paystack Webhook] Rate limited:', clientId);
      return NextResponse.json({ success: false, message: 'Too many requests' }, { status: 429 });
    }

    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) {
      console.error('[Paystack Webhook] PAYSTACK_SECRET_KEY not set — rejecting');
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    }

    // IMPORTANT: Read the raw body (as text) to verify signature BEFORE parsing.
    const rawBody = await req.text();

    const signature = req.headers.get('x-paystack-signature') || '';
    const expectedSignature = crypto
      .createHmac('sha512', secret)
      .update(rawBody)
      .digest('hex');

    const sigBuf = Buffer.from(signature, 'utf8');
    const expBuf = Buffer.from(expectedSignature, 'utf8');

    const validSignature =
      sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);

    if (!validSignature) {
      console.error('[Paystack Webhook] SIGNATURE MISMATCH — rejecting');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }

    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch {
      console.error('[Paystack Webhook] Invalid JSON body');
      return NextResponse.json({ success: false, message: 'Invalid JSON' }, { status: 400 });
    }

    const eventType: string = event?.event || '';
    const data = event?.data || {};
    const reference: string = data.reference || '';
    const metadata = data.metadata || {};

    // The order number was set in `metadata.order_number` during initialize.
    const rawOrderRef: string =
      metadata.order_number ||
      metadata.orderRef ||
      metadata.order ||
      '';

    // Strip any retry suffix just in case (e.g., "ORD-123-R1770000000" -> "ORD-123")
    const orderNumber = rawOrderRef ? rawOrderRef.replace(/-R\d+$/, '') : '';

    console.log(
      '[Paystack Webhook] event:', eventType,
      '| reference:', reference,
      '| order:', orderNumber,
      '| status:', data.status,
      '| amount:', data.amount
    );

    if (!orderNumber) {
      // Acknowledge so Paystack stops retrying, but log for investigation.
      console.warn('[Paystack Webhook] Missing order_number in metadata — ignoring');
      return NextResponse.json({ success: true, message: 'No order reference; ignored' });
    }

    // --------------------------------------------------
    // charge.success
    // --------------------------------------------------
    if (eventType === 'charge.success' && data.status === 'success') {
      const { data: existingOrder, error: fetchError } = await supabaseAdmin
        .from('orders')
        .select('id, order_number, payment_status, total, metadata')
        .eq('order_number', orderNumber)
        .single();

      if (fetchError || !existingOrder) {
        console.error('[Paystack Webhook] Order not found:', orderNumber);
        // 200 so Paystack doesn't retry forever; we can reconcile manually.
        return NextResponse.json({ success: false, message: 'Order not found' });
      }

      if (existingOrder.payment_status === 'paid') {
        console.log('[Paystack Webhook] Order already paid, skipping:', orderNumber);
        return NextResponse.json({ success: true, message: 'Order already processed' });
      }

      // Enforce payment method if it was explicitly set to something else
      const method = existingOrder.metadata?.payment_method;
      if (method && !['card', 'paystack'].includes(method)) {
        console.error('[Paystack Webhook] Wrong gateway for order:', orderNumber, '| method:', method);
        return NextResponse.json({ success: false, message: 'Gateway mismatch' }, { status: 400 });
      }

      // Verify amount (Paystack sends amount in the smallest unit — pesewas)
      const expectedAmountMinor = Math.round(Number(existingOrder.total) * 100);
      const paidAmountMinor = Number(data.amount || 0);
      if (!paidAmountMinor || Math.abs(paidAmountMinor - expectedAmountMinor) > 1) {
        console.error(
          '[Paystack Webhook] AMOUNT MISMATCH — REJECTING! Expected:',
          expectedAmountMinor, 'Got:', paidAmountMinor, 'Order:', orderNumber
        );
        return NextResponse.json(
          { success: false, message: 'Payment amount does not match order total' },
          { status: 400 }
        );
      }

      const { data: orderJson, error: updateError } = await supabaseAdmin.rpc('mark_order_paid', {
        order_ref: orderNumber,
        moolre_ref: `paystack-${reference}`,
      });

      if (updateError) {
        console.error('[Paystack Webhook] RPC Error:', updateError.message);
        return NextResponse.json({ success: false, message: 'Database update failed' }, { status: 500 });
      }

      if (!orderJson) {
        console.error('[Paystack Webhook] Order not found after RPC:', orderNumber);
        return NextResponse.json({ success: false, message: 'Order not found' });
      }

      console.log('[Paystack Webhook] Order updated! ID:', orderJson.id, '| Status:', orderJson.status);

      try {
        if (orderJson.email) {
          await supabaseAdmin.rpc('update_customer_stats', {
            p_customer_email: orderJson.email,
            p_order_total: orderJson.total,
          });
        }
      } catch (statsError: any) {
        console.error('[Paystack Webhook] Customer stats failed:', statsError.message);
      }

      try {
        console.log('[Paystack Webhook] Sending notifications for:', orderJson.order_number);
        await sendOrderConfirmation(orderJson);
        console.log('[Paystack Webhook] Notifications sent!');
      } catch (notifyError: any) {
        console.error('[Paystack Webhook] Notification failed:', notifyError.message);
      }

      return NextResponse.json({ success: true, message: 'Payment verified and order updated' });
    }

    // --------------------------------------------------
    // charge.failed (and any explicit failure status)
    // --------------------------------------------------
    if (eventType === 'charge.failed' || data.status === 'failed') {
      console.log('[Paystack Webhook] Payment FAILED for', orderNumber, '| reason:', data.gateway_response);

      const { data: failedOrder } = await supabaseAdmin
        .from('orders')
        .select('metadata, payment_status')
        .eq('order_number', orderNumber)
        .single();

      // Don't overwrite a paid order based on a stray failed event
      if (failedOrder?.payment_status !== 'paid') {
        await supabaseAdmin
          .from('orders')
          .update({
            payment_status: 'failed',
            metadata: {
              ...(failedOrder?.metadata || {}),
              paystack_reference: reference,
              failure_reason: data.gateway_response || 'Payment failed',
              failed_at: new Date().toISOString(),
            },
          })
          .eq('order_number', orderNumber);
      }

      return NextResponse.json({ success: true, message: 'Failure recorded' });
    }

    // Any other event type — acknowledge without action.
    console.log('[Paystack Webhook] Unhandled event type:', eventType);
    return NextResponse.json({ success: true, message: 'Event ignored' });
  } catch (error: any) {
    console.error('[Paystack Webhook] Critical Error:', error?.message);
    return NextResponse.json({ success: false, message: 'Internal server error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'Paystack webhook endpoint ready',
    timestamp: new Date().toISOString(),
  });
}
