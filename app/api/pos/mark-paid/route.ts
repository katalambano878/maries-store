import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function verifyAdmin(request: NextRequest): Promise<boolean> {
  const token =
    request.cookies.get('sb-access-token')?.value ||
    request.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return false;

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return false;

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  return profile?.role === 'admin' || profile?.role === 'staff';
}

export async function POST(request: NextRequest) {
  try {
    const isAdmin = await verifyAdmin(request);
    if (!isAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { order_ref, moolre_ref } = await request.json();

    if (!order_ref) {
      return NextResponse.json({ error: 'order_ref is required' }, { status: 400 });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data, error } = await supabase.rpc('mark_order_paid', {
      order_ref,
      moolre_ref: moolre_ref || null,
    });

    if (error) {
      console.error('[POS mark-paid] RPC error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, order: data });
  } catch (err: any) {
    console.error('[POS mark-paid] Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
