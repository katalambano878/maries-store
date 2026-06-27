/** Primary online payment gateway for this store. */
export const PRIMARY_PAYMENT_GATEWAY = 'hubtel';

export type PaymentGateway = 'hubtel' | 'moolre' | 'paystack';

/**
 * Resolve which gateway an order uses. Falls back to Hubtel (primary) when unknown.
 */
export function resolveOrderPaymentGateway(
  metadata: Record<string, unknown> | null | undefined,
  urlGateway?: string | null
): PaymentGateway {
  const fromUrl = (urlGateway || '').trim().toLowerCase();
  if (fromUrl === 'hubtel' || fromUrl === 'moolre' || fromUrl === 'paystack') {
    return fromUrl as PaymentGateway;
  }

  const gw = String(metadata?.payment_gateway || '').toLowerCase();
  if (gw === 'hubtel' || gw === 'moolre' || gw === 'paystack') {
    return gw as PaymentGateway;
  }

  const pm = String(metadata?.payment_method || '').toLowerCase();
  if (pm === 'momo' || pm === 'moolre') return 'moolre';
  if (pm === 'card' || pm === 'paystack') return 'paystack';

  return PRIMARY_PAYMENT_GATEWAY;
}

export function isMoolreGateway(gateway: PaymentGateway): boolean {
  return gateway === 'moolre';
}

export function isHubtelGateway(gateway: PaymentGateway): boolean {
  return gateway === 'hubtel';
}

export function isPaystackGateway(gateway: PaymentGateway): boolean {
  return gateway === 'paystack';
}
