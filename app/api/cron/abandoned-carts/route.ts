import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendSMS } from '@/lib/notifications';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const BRAND_URL = ((/^https?:\/\//.test(process.env.NEXT_PUBLIC_APP_URL || '')
  ? process.env.NEXT_PUBLIC_APP_URL!
  : `https://${process.env.NEXT_PUBLIC_APP_URL || 'www.shopmarieshair.com'}`)).replace(/\/+$/, '');

export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Find abandoned carts that:
    // 1. Were created more than 1 hour ago (give time to complete on their own)
    // 2. Were created within the last 48 hours (don't spam old carts)
    // 3. Haven't had a reminder sent
    // 4. Haven't been recovered (converted to an order)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const { data: abandonedCarts, error } = await supabase
      .from('abandoned_carts')
      .select('id, email, phone, first_name, last_name, cart_items, cart_total')
      .eq('reminder_sent', false)
      .eq('recovered', false)
      .lt('created_at', oneHourAgo)
      .gt('created_at', fortyEightHoursAgo)
      .order('created_at', { ascending: true })
      .limit(50);

    if (error) {
      console.error('[Abandoned Carts] Query error:', error);
      throw error;
    }

    if (!abandonedCarts || abandonedCarts.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No abandoned carts to remind',
        processed: 0,
      });
    }

    console.log(`[Abandoned Carts] Found ${abandonedCarts.length} carts to remind`);

    let sent = 0;
    let failed = 0;

    for (const cart of abandonedCarts) {
      try {
        const name = cart.first_name || 'there';
        const total = Number(cart.cart_total || 0).toFixed(2);
        const itemCount = Array.isArray(cart.cart_items) ? cart.cart_items.length : 0;
        const itemWord = itemCount === 1 ? 'item' : 'items';

        // Check the cart wasn't already converted to an order by this phone/email
        const { data: existingOrder } = await supabase
          .from('orders')
          .select('id')
          .eq('phone', cart.phone)
          .gt('created_at', fortyEightHoursAgo)
          .limit(1)
          .maybeSingle();

        if (existingOrder) {
          // They already placed an order, mark as recovered
          await supabase
            .from('abandoned_carts')
            .update({ recovered: true, recovered_at: new Date().toISOString() })
            .eq('id', cart.id);
          continue;
        }

        if (cart.phone) {
          const smsMessage = `Hi ${name}! You left ${itemCount} ${itemWord} (GH₵${total}) in your cart at Maries Hair. Complete your order here: ${BRAND_URL}/shop`;

          await sendSMS({ to: cart.phone, message: smsMessage });
        }

        await supabase
          .from('abandoned_carts')
          .update({
            reminder_sent: true,
            reminder_sent_at: new Date().toISOString(),
          })
          .eq('id', cart.id);

        sent++;
        console.log(`[Abandoned Carts] Sent reminder to ${cart.phone || cart.email}`);
      } catch (err) {
        console.error(`[Abandoned Carts] Failed for cart ${cart.id}:`, err);
        failed++;
      }
    }

    return NextResponse.json({
      success: true,
      message: `Processed ${abandonedCarts.length} abandoned carts`,
      sent,
      failed,
    });
  } catch (error: any) {
    console.error('[Abandoned Carts] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
