import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { sendOrderConfirmation } from '@/lib/notifications';
import { checkRateLimit, getClientIdentifier, RATE_LIMITS } from '@/lib/rate-limit';

export async function POST(req: Request) {
  try {
    const clientId = getClientIdentifier(req);
    const rateLimitResult = checkRateLimit(`verify:paystack:${clientId}`, RATE_LIMITS.payment);
    if (!rateLimitResult.success) {
      return NextResponse.json({ success: false, message: 'Too many requests' }, { status: 429 });
    }

    const { orderNumber, reference } = await req.json();
    if (!orderNumber || typeof orderNumber !== 'string') {
      return NextResponse.json({ success: false, message: 'Missing or invalid orderNumber' }, { status: 400 });
    }
    if (!reference || typeof reference !== 'string') {
      return NextResponse.json({ success: false, message: 'Missing Paystack reference' }, { status: 400 });
    }
    if (!process.env.PAYSTACK_SECRET_KEY) {
      return NextResponse.json({ success: false, message: 'Paystack is not configured' }, { status: 500 });
    }

    const { data: order, error: fetchError } = await supabaseAdmin
      .from('orders')
      .select('id, order_number, payment_status, status, total, email, metadata')
      .eq('order_number', orderNumber)
      .single();

    if (fetchError || !order) {
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

    if (order.metadata?.payment_method && !['card', 'paystack'].includes(order.metadata.payment_method)) {
      return NextResponse.json({ success: false, message: 'This order does not use Card payment' }, { status: 400 });
    }

    const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      },
    });

    const verifyResult = await verifyRes.json();
    const isSuccess = verifyRes.ok && verifyResult.status === true && verifyResult.data?.status === 'success';
    if (!isSuccess) {
      return NextResponse.json({
        success: false,
        status: order.status,
        payment_status: order.payment_status,
        message: verifyResult.message || 'Payment not verified by Paystack',
      });
    }

    const expectedAmount = Math.round(Number(order.total) * 100);
    const paidAmount = Number(verifyResult.data?.amount || 0);
    if (Math.abs(paidAmount - expectedAmount) > 1) {
      return NextResponse.json({ success: false, message: 'Amount mismatch during payment verification' }, { status: 400 });
    }

    const { data: orderJson, error: updateError } = await supabaseAdmin.rpc('mark_order_paid', {
      order_ref: orderNumber,
      moolre_ref: `paystack-${reference}`,
    });

    if (updateError) {
      return NextResponse.json({ success: false, message: 'Failed to update order' }, { status: 500 });
    }

    if (orderJson?.email) {
      try {
        await supabaseAdmin.rpc('update_customer_stats', {
          p_customer_email: orderJson.email,
          p_order_total: orderJson.total,
        });
      } catch (statsError: any) {
        console.error('[Paystack Verify] Customer stats failed:', statsError.message);
      }
    }

    if (orderJson) {
      try {
        await sendOrderConfirmation(orderJson);
      } catch (notifyError: any) {
        console.error('[Paystack Verify] Notification failed:', notifyError.message);
      }
    }

    return NextResponse.json({
      success: true,
      status: 'processing',
      payment_status: 'paid',
      message: 'Payment verified and order updated',
    });
  } catch (error: any) {
    console.error('[Paystack Verify] Error:', error.message);
    return NextResponse.json({ success: false, message: 'Internal error' }, { status: 500 });
  }
}
