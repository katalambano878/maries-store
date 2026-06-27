import { supabaseAdmin } from '@/lib/supabase-admin';
import { sendOrderConfirmation } from '@/lib/notifications';
import {
  amountsMatch,
  hubtelCheckTransactionStatus,
  hubtelSettlementAmount,
  isHubtelPaid,
  NormalizedHubtelStatus,
} from '@/lib/hubtel';

export interface HubtelConfirmResult {
  success: boolean;
  alreadyPaid?: boolean;
  orderJson?: Record<string, unknown>;
  status?: NormalizedHubtelStatus;
  message?: string;
}

/**
 * Re-query Hubtel RMSC and mark order paid when settlement matches order total.
 * Idempotent — safe if callback and verify both run.
 */
export async function confirmHubtelPaymentFromStatus(
  orderNumber: string,
  clientReference: string,
  hubtelRefForMetadata: string
): Promise<HubtelConfirmResult> {
  const { data: order, error: fetchError } = await supabaseAdmin
    .from('orders')
    .select('id, order_number, payment_status, status, total, email, metadata')
    .eq('order_number', orderNumber)
    .single();

  if (fetchError || !order) {
    return { success: false, message: 'Order not found' };
  }

  if (order.payment_status === 'paid') {
    return { success: true, alreadyPaid: true, orderJson: order as Record<string, unknown> };
  }

  const status = await hubtelCheckTransactionStatus(clientReference);

  if (!isHubtelPaid(status.status)) {
    return {
      success: false,
      message: `Payment not confirmed by Hubtel (status: ${status.status || 'unknown'})`,
      status,
    };
  }

  const settlement = hubtelSettlementAmount(status);
  const expected = Number(order.total);
  if (settlement == null || !amountsMatch(expected, settlement)) {
    console.error(
      '[Hubtel Confirm] Amount mismatch — order:',
      orderNumber,
      'expected:',
      expected,
      'settlement:',
      settlement
    );
    return {
      success: false,
      message: 'Settlement amount does not match order total',
      status,
    };
  }

  const { data: orderJson, error: updateError } = await supabaseAdmin.rpc('mark_order_paid', {
    order_ref: orderNumber,
    moolre_ref: `hubtel-${hubtelRefForMetadata}`,
  });

  if (updateError) {
    console.error('[Hubtel Confirm] mark_order_paid failed:', updateError.message);
    return { success: false, message: 'Failed to update order', status };
  }

  if (orderJson?.email) {
    try {
      await supabaseAdmin.rpc('update_customer_stats', {
        p_customer_email: orderJson.email,
        p_order_total: orderJson.total,
      });
    } catch (statsError: unknown) {
      const msg = statsError instanceof Error ? statsError.message : String(statsError);
      console.error('[Hubtel Confirm] Customer stats failed:', msg);
    }
  }

  if (orderJson) {
    try {
      await sendOrderConfirmation(orderJson);
    } catch (notifyError: unknown) {
      const msg = notifyError instanceof Error ? notifyError.message : String(notifyError);
      console.error('[Hubtel Confirm] Notification failed:', msg);
    }
  }

  return { success: true, orderJson: orderJson as Record<string, unknown>, status };
}
