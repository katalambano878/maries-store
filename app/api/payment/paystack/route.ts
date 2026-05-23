import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { checkRateLimit, getClientIdentifier, RATE_LIMITS } from '@/lib/rate-limit';

export async function POST(req: Request) {
  try {
    const clientId = getClientIdentifier(req);
    const rateLimitResult = checkRateLimit(`payment:paystack:${clientId}`, RATE_LIMITS.payment);
    if (!rateLimitResult.success) {
      return NextResponse.json({ success: false, message: 'Too many requests. Please try again later.' }, { status: 429 });
    }

    const body = await req.json();
    const { orderId, customerEmail } = body;
    if (!orderId || typeof orderId !== 'string') {
      return NextResponse.json({ success: false, message: 'Missing or invalid orderId' }, { status: 400 });
    }

    if (!process.env.PAYSTACK_SECRET_KEY) {
      return NextResponse.json({ success: false, message: 'Paystack is not configured' }, { status: 500 });
    }

    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId);
    const query = supabaseAdmin
      .from('orders')
      .select('id, order_number, total, email, payment_status')
      .limit(1);

    if (isUUID) {
      query.or(`id.eq.${orderId},order_number.eq.${orderId}`);
    } else {
      query.eq('order_number', orderId);
    }

    const { data: order, error: orderError } = await query.single();
    if (orderError || !order) {
      return NextResponse.json({ success: false, message: 'Order not found' }, { status: 404 });
    }

    if (order.payment_status === 'paid') {
      return NextResponse.json({ success: false, message: 'Order is already paid' }, { status: 400 });
    }

    const amount = Math.round(Number(order.total) * 100); // pesewas
    if (!amount || amount <= 0) {
      return NextResponse.json({ success: false, message: 'Invalid order amount' }, { status: 400 });
    }

    const orderRef = order.order_number || orderId;
    const requestUrl = new URL(req.url);
    const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || requestUrl.origin).replace(/\/+$/, '');

    const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      },
      body: JSON.stringify({
        email: customerEmail || order.email || 'customer@shopmarieshair.com',
        amount,
        currency: 'GHS',
        callback_url: `${baseUrl}/order-success?order=${encodeURIComponent(orderRef)}&payment_success=true&gateway=paystack`,
        metadata: {
          order_number: orderRef,
          source: 'shop_checkout',
        },
      }),
    });

    const result = await paystackRes.json();
    if (!paystackRes.ok || !result.status || !result.data?.authorization_url) {
      return NextResponse.json(
        { success: false, message: result.message || 'Failed to initialize Paystack payment' },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      url: result.data.authorization_url,
      reference: result.data.reference,
    });
  } catch (error: any) {
    console.error('Paystack init error:', error);
    return NextResponse.json({ success: false, message: 'Internal Server Error' }, { status: 500 });
  }
}
