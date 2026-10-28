import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { page, referrer, visitorId } = body;

    const supabase = supabaseAdmin;

    const userAgent = request.headers.get('user-agent') || '';

    await supabase.from('site_visits').insert({
      page: page || '/',
      referrer: referrer || null,
      user_agent: userAgent,
      visitor_id: visitorId || null,
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
