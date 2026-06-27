/**
 * Hubtel Online Checkout API client (no SDK).
 * Auth: HTTP Basic base64(HUBTEL_API_ID:HUBTEL_API_KEY)
 */

const HUBTEL_INITIATE_URL = 'https://payproxyapi.hubtel.com/items/initiate';
/** Public RMSC status endpoint — no IP whitelisting required (Basic auth only). */
const HUBTEL_RMSC_STATUS_BASE = 'https://rmsc.hubtel.com/v1/merchantaccount/merchants';

function getHubtelCredentials() {
  const apiId = process.env.HUBTEL_API_ID?.trim();
  const apiKey = process.env.HUBTEL_API_KEY?.trim();
  const merchantAccount = process.env.HUBTEL_MERCHANT_ACCOUNT_NUMBER?.trim();
  return { apiId, apiKey, merchantAccount };
}

export function isHubtelConfigured(): boolean {
  const { apiId, apiKey, merchantAccount } = getHubtelCredentials();
  return Boolean(apiId && apiKey && merchantAccount);
}

function authHeader(): string {
  const { apiId, apiKey } = getHubtelCredentials();
  if (!apiId || !apiKey) throw new Error('Hubtel credentials not configured');
  return `Basic ${Buffer.from(`${apiId}:${apiKey}`).toString('base64')}`;
}

/** Hubtel hard-limits clientReference to 32 chars. */
export function makeHubtelClientReference(orderRef: string): string {
  const suffix = `-r${Date.now().toString(36)}`;
  const maxBase = 32 - suffix.length;
  const base = orderRef.slice(0, maxBase);
  return `${base}${suffix}`.slice(0, 32);
}

/** Strip trailing `-r<base36>` so callbacks recover the order number. */
export function stripHubtelReferenceSuffix(ref: string): string {
  return ref.replace(/-r[a-z0-9]+$/i, '');
}

/** True only when payment actually succeeded — NOT ResponseCode 0000 alone. */
export function isHubtelPaid(status: string | null | undefined): boolean {
  const s = (status || '').trim().toLowerCase();
  return ['paid', 'success', 'successful', 'completed'].includes(s);
}

export function isHubtelFailure(
  status: string | null | undefined,
  responseCode?: string | null
): boolean {
  const s = (status || '').trim().toLowerCase();
  if (
    ['failed', 'declined', 'cancelled', 'canceled', 'expired', 'abandoned', 'rejected'].includes(s)
  ) {
    return true;
  }
  const code = (responseCode || '').trim();
  return code === '2001' || code === '4000' || code === '4070';
}

/** Normalize Ghana phone numbers to 233XXXXXXXXX. */
export function normalizeGhPhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let digits = input.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('233')) return digits;
  if (digits.startsWith('0')) return `233${digits.slice(1)}`;
  if (digits.length === 9) return `233${digits}`;
  return digits;
}

function parseNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface NormalizedHubtelStatus {
  responseCode: string | null;
  status: string | null;
  amount: number | null;
  charges: number | null;
  amountAfterCharges: number | null;
  checkoutId: string | null;
  clientReference: string | null;
  raw: unknown;
}

/** Normalize RMSC status response (PascalCase, Data may be array). */
export function normalizeHubtelStatusResponse(raw: unknown): NormalizedHubtelStatus {
  const root = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  let data = root.Data ?? root.data;
  if (Array.isArray(data)) data = data[0];
  if (!data || typeof data !== 'object') data = root;

  const d = data as Record<string, unknown>;

  const status =
    (d.TransactionStatus as string) ??
    (d.InvoiceStatus as string) ??
    (d.Status as string) ??
    (d.status as string) ??
    (root.Status as string) ??
    null;

  const amount =
    parseNum(d.TransactionAmount) ??
    parseNum(d.Amount) ??
    parseNum(d.amount) ??
    parseNum(root.Amount);

  const charges = parseNum(d.Fee) ?? parseNum(d.fee) ?? parseNum(d.charges);

  const amountAfterCharges =
    parseNum(d.AmountAfterFees) ??
    parseNum(d.amountAfterCharges) ??
    parseNum(d.AmountAfterFee);

  const checkoutId =
    (d.CheckoutId as string) ?? (d.checkoutId as string) ?? (root.CheckoutId as string) ?? null;

  const clientReference =
    (d.ClientReference as string) ??
    (d.clientReference as string) ??
    (root.ClientReference as string) ??
    null;

  const responseCode =
    (root.ResponseCode as string) ?? (root.responseCode as string) ?? (d.ResponseCode as string) ?? null;

  return {
    responseCode,
    status,
    amount,
    charges,
    amountAfterCharges,
    checkoutId,
    clientReference,
    raw: root,
  };
}

export function hubtelSettlementAmount(status: NormalizedHubtelStatus): number | null {
  return status.amountAfterCharges ?? status.amount;
}

export function amountsMatch(expected: number, actual: number, tolerance = 0.01): boolean {
  return Math.abs(expected - actual) <= tolerance;
}

export interface HubtelInitiateParams {
  totalAmount: number;
  description: string;
  callbackUrl: string;
  returnUrl: string;
  cancellationUrl: string;
  clientReference: string;
  payeeName?: string;
  payeeMobileNumber?: string;
  payeeEmail?: string;
}

export interface HubtelInitiateResult {
  checkoutUrl: string | null;
  checkoutDirectUrl: string | null;
  checkoutId: string | null;
  responseCode: string | null;
  message: string | null;
  raw: unknown;
}

export async function hubtelInitiateCheckout(params: HubtelInitiateParams): Promise<HubtelInitiateResult> {
  const { merchantAccount } = getHubtelCredentials();
  if (!merchantAccount) throw new Error('HUBTEL_MERCHANT_ACCOUNT_NUMBER not configured');

  const payload = {
    totalAmount: params.totalAmount,
    description: params.description,
    callbackUrl: params.callbackUrl,
    returnUrl: params.returnUrl,
    cancellationUrl: params.cancellationUrl,
    merchantAccountNumber: merchantAccount,
    clientReference: params.clientReference,
    ...(params.payeeName ? { payeeName: params.payeeName } : {}),
    ...(params.payeeMobileNumber ? { payeeMobileNumber: params.payeeMobileNumber } : {}),
    ...(params.payeeEmail ? { payeeEmail: params.payeeEmail } : {}),
  };

  const res = await fetch(HUBTEL_INITIATE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader(),
    },
    body: JSON.stringify(payload),
  });

  const raw = await res.json().catch(() => ({}));
  const data = (raw?.data ?? raw?.Data ?? raw) as Record<string, unknown>;

  const checkoutUrl =
    (data.checkoutUrl as string) ??
    (data.CheckoutUrl as string) ??
    (data.checkoutDirectUrl as string) ??
    (data.CheckoutDirectUrl as string) ??
    null;

  const checkoutDirectUrl =
    (data.checkoutDirectUrl as string) ?? (data.CheckoutDirectUrl as string) ?? null;

  const checkoutId = (data.checkoutId as string) ?? (data.CheckoutId as string) ?? null;

  return {
    checkoutUrl,
    checkoutDirectUrl,
    checkoutId,
    responseCode: (raw?.ResponseCode as string) ?? (raw?.responseCode as string) ?? null,
    message: (raw?.Message as string) ?? (raw?.message as string) ?? null,
    raw,
  };
}

export async function hubtelCheckTransactionStatus(clientReference: string): Promise<NormalizedHubtelStatus> {
  const { merchantAccount } = getHubtelCredentials();
  if (!merchantAccount) throw new Error('HUBTEL_MERCHANT_ACCOUNT_NUMBER not configured');

  const url = `${HUBTEL_RMSC_STATUS_BASE}/${encodeURIComponent(
    merchantAccount
  )}/transactions/status?clientReference=${encodeURIComponent(clientReference)}`;

  console.log('[Hubtel RMSC] GET status — merchant:', merchantAccount, '| clientReference:', clientReference);

  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: authHeader() },
  });

  const raw = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error('[Hubtel RMSC] HTTP', res.status, '| clientReference:', clientReference, '| body:', raw);
  }

  const normalized = normalizeHubtelStatusResponse(raw);
  console.log(
    '[Hubtel RMSC] status:',
    normalized.status,
    '| responseCode:',
    normalized.responseCode,
    '| amount:',
    normalized.amount,
    '| amountAfterCharges:',
    normalized.amountAfterCharges
  );

  return normalized;
}
