import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { confirmSmsCheckout, getSmsBilling, startSmsCheckout, taysendConfigured } from '@/lib/taysend-billing';

export const dynamic = 'force-dynamic';

const PACKAGE_ID = /^[a-z0-9-]{1,40}$/;
const PAYMENT_ID = /^pay_[A-Za-z0-9]+$/;

async function verifyAdmin(request: NextRequest): Promise<boolean> {
  const token =
    request.cookies.get('sb-access-token')?.value ||
    request.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return false;

  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return false;

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  return profile?.role === 'admin' || profile?.role === 'staff';
}

export async function GET(request: NextRequest) {
  if (!(await verifyAdmin(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!taysendConfigured()) {
    return NextResponse.json({ configured: false });
  }

  try {
    const billing = await getSmsBilling();
    const checkoutId = request.nextUrl.searchParams.get('checkout') || '';
    const checkout = PAYMENT_ID.test(checkoutId) ? await confirmSmsCheckout(checkoutId) : null;
    return NextResponse.json({ configured: true, ...billing, checkout });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not load SMS packages.';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  if (!(await verifyAdmin(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!taysendConfigured()) {
    return NextResponse.json({ error: 'SMS buying is not connected on this store yet.' }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));
  const packageId = typeof body?.package_id === 'string' ? body.package_id : '';
  if (!PACKAGE_ID.test(packageId)) {
    return NextResponse.json({ error: 'Choose a package from the list.' }, { status: 400 });
  }

  try {
    const checkout = await startSmsCheckout(packageId);
    return NextResponse.json(checkout);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not start payment.';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
