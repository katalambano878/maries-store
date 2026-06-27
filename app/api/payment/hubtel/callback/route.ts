import { NextResponse } from 'next/server';
import { checkRateLimit, getClientIdentifier, RATE_LIMITS } from '@/lib/rate-limit';
import {
  isHubtelFailure,
  stripHubtelReferenceSuffix,
} from '@/lib/hubtel';
import { confirmHubtelPaymentFromStatus } from '@/lib/hubtel-payment-confirm';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function parseCallbackBody(req: Request): Promise<Record<string, unknown>> {
  const contentType = req.headers.get('content-type') || '';
  const text = await req.text();
  if (!text.trim()) return {};

  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(text);
      return typeof parsed === 'object' && parsed ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }

  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed ? (parsed as Record<string, unknown>) : {};
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

function extractCallbackFields(body: Record<string, unknown>) {
  const data = (body.Data ?? body.data) as Record<string, unknown> | undefined;
  const clientReference =
    (data?.ClientReference as string) ??
    (data?.clientReference as string) ??
    (body.ClientReference as string) ??
    (body.clientReference as string) ??
    '';

  const checkoutId =
    (data?.CheckoutId as string) ??
    (data?.checkoutId as string) ??
    (body.CheckoutId as string) ??
    null;

  const status =
    (data?.TransactionStatus as string) ??
    (data?.InvoiceStatus as string) ??
    (data?.Status as string) ??
    (data?.status as string) ??
    (body.Status as string) ??
    (body.status as string) ??
    null;

  const responseCode = (body.ResponseCode as string) ?? (body.responseCode as string) ?? null;

  return { clientReference, checkoutId, status, responseCode };
}

export async function POST(req: Request) {
  console.log('[Hubtel Callback] POST received at', new Date().toISOString());

  try {
    const clientId = getClientIdentifier(req);
    const rateLimitResult = checkRateLimit(`callback:hubtel:${clientId}`, RATE_LIMITS.callback);
    if (!rateLimitResult.success) {
      return NextResponse.json({ success: false, message: 'Too many requests' }, { status: 429 });
    }

    const body = await parseCallbackBody(req);
    const { clientReference, checkoutId, status, responseCode } = extractCallbackFields(body);

    if (!clientReference) {
      console.warn('[Hubtel Callback] Missing ClientReference — ignoring');
      return NextResponse.json({ success: true, message: 'No client reference; ignored' });
    }

    const orderNumber = stripHubtelReferenceSuffix(clientReference);
    console.log(
      '[Hubtel Callback] order:',
      orderNumber,
      '| clientRef:',
      clientReference,
      '| status:',
      status,
      '| responseCode:',
      responseCode
    );

    const { data: existingOrder, error: fetchError } = await supabaseAdmin
      .from('orders')
      .select('id, order_number, payment_status, metadata')
      .eq('order_number', orderNumber)
      .single();

    if (fetchError || !existingOrder) {
      console.error('[Hubtel Callback] Order not found:', orderNumber);
      return NextResponse.json({ success: false, message: 'Order not found' });
    }

    if (existingOrder.payment_status === 'paid') {
      console.log('[Hubtel Callback] Already paid:', orderNumber);
      return NextResponse.json({ success: true, message: 'Order already processed' });
    }

    // Callback is a wake-up signal only — always re-verify via public RMSC status API
    // (GET .../merchants/{account}/transactions/status?clientReference=...)
    // Never mark paid from the callback body alone.
    const hubtelRef = checkoutId || clientReference;
    const result = await confirmHubtelPaymentFromStatus(orderNumber, clientReference, hubtelRef);

    if (result.success) {
      console.log('[Hubtel Callback] Order confirmed paid via RMSC:', orderNumber);
      return NextResponse.json({ success: true, message: 'Payment verified and order updated' });
    }

    console.log('[Hubtel Callback] RMSC not paid yet:', result.message);

    if (isHubtelFailure(status, responseCode)) {
      const meta = (existingOrder.metadata || {}) as Record<string, unknown>;
      await supabaseAdmin
        .from('orders')
        .update({
          payment_status: 'failed',
          metadata: {
            ...meta,
            hubtel_checkout_id: checkoutId,
            hubtel_failure_status: status,
            hubtel_response_code: responseCode,
            failure_reason: status || responseCode || 'Payment failed',
            failed_at: new Date().toISOString(),
          },
        })
        .eq('order_number', orderNumber);

      console.log('[Hubtel Callback] Payment failed for:', orderNumber);
      return NextResponse.json({ success: true, message: 'Failure recorded' });
    }

    console.log('[Hubtel Callback] Non-terminal status — no action:', status);
    return NextResponse.json({ success: true, message: 'Status pending or ignored' });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[Hubtel Callback] Error:', msg);
    return NextResponse.json({ success: false, message: 'Internal server error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
