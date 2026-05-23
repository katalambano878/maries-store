import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { sendOrderConfirmation } from '@/lib/notifications';
import { checkRateLimit, getClientIdentifier, RATE_LIMITS } from '@/lib/rate-limit';
import { moolreEmbedHeaders, moolreAmountsMatch, moolreMessageImpliesSuccess } from '@/lib/moolre-embed';

/**
 * Confirms MoMo/embed payment via Moolre POST /open/transact/status + mark_order_paid.
 * (/embed/status is not served — use open/transact/status with type/idtype/id/accountnumber.)
 * Tries redirect ?reference=, stored refs, order number; optional idtype 1 vs 2 per ref;
 * tolerates GHS major vs pesewas; sends X-API-KEY when configured.
 */
export async function POST(req: Request) {
    try {
        const clientId = getClientIdentifier(req);
        const rateLimitResult = checkRateLimit(`verify:${clientId}`, RATE_LIMITS.payment);

        if (!rateLimitResult.success) {
            return NextResponse.json(
                { success: false, message: 'Too many requests' },
                { status: 429 }
            );
        }

        const body = await req.json();
        const orderNumber = body.orderNumber as string | undefined;
        const gatewayReference =
            typeof body.moolreGatewayReference === 'string' ? body.moolreGatewayReference.trim() : '';

        if (!orderNumber || typeof orderNumber !== 'string') {
            return NextResponse.json({ success: false, message: 'Missing or invalid orderNumber' }, { status: 400 });
        }

        if (!/^ORD-\d+-\d+$/.test(orderNumber)) {
            return NextResponse.json({ success: false, message: 'Invalid order number format' }, { status: 400 });
        }

        console.log('[Verify] Checking payment for:', orderNumber, gatewayReference ? '| gateway ref' : '');

        const { data: order, error: fetchError } = await supabaseAdmin
            .from('orders')
            .select('id, order_number, payment_status, status, total, email, phone, shipping_address, metadata')
            .eq('order_number', orderNumber)
            .single();

        if (fetchError || !order) {
            console.error('[Verify] Order not found:', orderNumber);
            return NextResponse.json({ success: false, message: 'Order not found' }, { status: 404 });
        }

        if (order.payment_status === 'paid') {
            return NextResponse.json({
                success: true,
                status: order.status,
                payment_status: order.payment_status,
                message: 'Order already paid'
            });
        }

        const meta = (order.metadata || {}) as Record<string, unknown>;
        if (meta.payment_method && meta.payment_method !== 'moolre' && meta.payment_method !== 'momo') {
            return NextResponse.json({
                success: false,
                message: 'This order does not use Moolre payment'
            }, { status: 400 });
        }

        let moolreApiVerified = false;

        if (!process.env.MOOLRE_API_USER || !process.env.MOOLRE_API_PUBKEY || !process.env.MOOLRE_ACCOUNT_NUMBER) {
            console.error('[Verify] Missing Moolre API credentials or MOOLRE_ACCOUNT_NUMBER');
            return NextResponse.json({
                success: false,
                status: order.status,
                payment_status: order.payment_status,
                message: 'Payment verification unavailable'
            }, { status: 503 });
        }

        const accountNumber = process.env.MOOLRE_ACCOUNT_NUMBER.trim();

        const refsToTry: string[] = [];
        if (gatewayReference) refsToTry.push(gatewayReference);
        const ext =
            (typeof meta.moolre_external_ref === 'string' && meta.moolre_external_ref.trim()) ||
            (typeof meta.moolre_unique_ref === 'string' && meta.moolre_unique_ref.trim());
        if (ext) refsToTry.push(ext);
        const emb =
            typeof meta.moolre_embed_reference === 'string' ? meta.moolre_embed_reference.trim() : '';
        if (emb) refsToTry.push(emb);
        refsToTry.push(orderNumber);

        const seenRef = new Set<string>();
        const uniqueRefs = refsToTry.filter((r) => {
            if (!r || seenRef.has(r)) return false;
            seenRef.add(r);
            return true;
        });

        const headers = moolreEmbedHeaders();

        const MOOLRE_STATUS_URL = 'https://api.moolre.com/open/transact/status';

        for (const ref of uniqueRefs) {
            if (moolreApiVerified) break;

            /** idtype 1 = external ref style; 2 = alternate (e.g. internal id) — try both. */
            const idtypes = [1, 2] as const;

            for (const idtype of idtypes) {
                if (moolreApiVerified) break;

                const jsonBody = {
                    type: 1,
                    idtype,
                    id: ref,
                    accountnumber: accountNumber,
                };

                try {
                    console.log('[Verify] open/transact/status', { idtype, id: ref });

                    const checkResponse = await fetch(MOOLRE_STATUS_URL, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(jsonBody),
                    });

                    const rawText = await checkResponse.text();
                    let checkResult: Record<string, unknown>;
                    try {
                        checkResult = JSON.parse(rawText) as Record<string, unknown>;
                    } catch {
                        console.error('[Verify] Non-JSON Moolre response:', rawText.slice(0, 200));
                        continue;
                    }

                    console.log('[Verify] Moolre response:', JSON.stringify(checkResult));

                    const data = (checkResult.data || {}) as Record<string, unknown>;

                    const apiOk = checkResult.status === 1 || checkResult.status === '1';
                    /** open/transact/status uses txstatus; callbacks/embed may use txtstatus */
                    const txRaw = data.txstatus ?? data.txtstatus;
                    if (txRaw === 2 || txRaw === '2') continue;
                    const txOk = txRaw === 1 || txRaw === '1';
                    const statusStr = String(
                        data.status ?? data.txtstatus_description ?? ''
                    ).toLowerCase();
                    const messageStr = String(checkResult.message || '').toLowerCase();

                    const hasExplicitTx =
                        data.txstatus !== undefined ||
                        data.txtstatus !== undefined;
                    const statusOk = hasExplicitTx
                        ? txOk
                        : statusStr.includes('success') ||
                          statusStr.includes('complet') ||
                          statusStr === 'paid' ||
                          moolreMessageImpliesSuccess(messageStr);

                    const candidate =
                        apiOk &&
                        statusOk &&
                        !messageStr.includes('not found') &&
                        !/fail|error|declin|invalid/i.test(messageStr);

                    if (!candidate) continue;

                    const extRef = data.externalref != null ? String(data.externalref) : '';
                    if (extRef && /^ORD-/i.test(extRef)) {
                        const normalized = extRef.replace(/-R\d+$/, '');
                        if (normalized !== orderNumber && !extRef.includes(orderNumber)) {
                            console.warn('[Verify] externalref does not match order; skipping.', {
                                extRef,
                                orderNumber,
                            });
                            continue;
                        }
                    }

                    const rawAmt = data.amount ?? data.value;
                    if (rawAmt != null && rawAmt !== '') {
                        if (!moolreAmountsMatch(rawAmt, Number(order.total))) {
                            console.error(
                                '[Verify] Amount mismatch. Order total:',
                                order.total,
                                'Moolre amount/value:',
                                rawAmt
                            );
                            continue;
                        }
                    }

                    moolreApiVerified = true;
                    console.log('[Verify] Payment confirmed. ref:', ref, 'idtype:', idtype);
                } catch (moolreError: unknown) {
                    const msg = moolreError instanceof Error ? moolreError.message : String(moolreError);
                    console.warn('[Verify] Request error:', msg);
                }
            }
        }

        if (!moolreApiVerified) {
            return NextResponse.json({
                success: false,
                status: order.status,
                payment_status: order.payment_status,
                message: 'Payment not yet confirmed by payment provider',
                hint: 'Check Vercel logs for [Verify]. Ensure MOOLRE_API_USER, MOOLRE_API_PUBKEY, MOOLRE_ACCOUNT_NUMBER, and optional MOOLRE_API_PRIVATE_KEY match Moolre dashboard.',
            });
        }

        const { data: orderJson, error: updateError } = await supabaseAdmin.rpc('mark_order_paid', {
            order_ref: orderNumber,
            moolre_ref: 'moolre-api-verify',
        });

        if (updateError) {
            console.error('[Verify] RPC Error:', updateError.message);
            return NextResponse.json({ success: false, message: 'Failed to update order' }, { status: 500 });
        }

        if (orderJson?.email) {
            try {
                await supabaseAdmin.rpc('update_customer_stats', {
                    p_customer_email: orderJson.email,
                    p_order_total: orderJson.total,
                });
            } catch (statsError: unknown) {
                const msg = statsError instanceof Error ? statsError.message : String(statsError);
                console.error('[Verify] Customer stats failed:', msg);
            }
        }

        if (orderJson) {
            try {
                await sendOrderConfirmation(orderJson);
            } catch (notifyError: unknown) {
                const msg = notifyError instanceof Error ? notifyError.message : String(notifyError);
                console.error('[Verify] Notification failed:', msg);
            }
        }

        return NextResponse.json({
            success: true,
            status: 'processing',
            payment_status: 'paid',
            message: 'Payment verified and order updated',
        });
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('[Verify] Error:', msg);
        return NextResponse.json({ success: false, message: 'Internal error' }, { status: 500 });
    }
}
