import { NextResponse } from 'next/server';
import { isPlainPostgres } from '@/lib/db/mode';
import { createPasswordResetToken, resetPasswordWithToken } from '@/lib/db/auth';
import { sendPasswordResetEmail } from '@/lib/notifications';
import { isValidEmail } from '@/lib/sanitize';
import { checkRateLimit, getClientIdentifier, RATE_LIMITS } from '@/lib/rate-limit';

/**
 * POST { email }            — email a reset link (same reply whether or not the account exists)
 * PUT  { token, password }  — set the new password
 */
export async function POST(request: Request) {
  if (!isPlainPostgres()) {
    return NextResponse.json({ error: 'Password reset is not available' }, { status: 503 });
  }
  const ip = getClientIdentifier(request);
  if (!checkRateLimit(`pw-reset:${ip}`, RATE_LIMITS.auth).success) {
    return NextResponse.json({ error: 'Too many requests. Please wait a minute.' }, { status: 429 });
  }

  const body = await request.json().catch(() => ({}));
  const email = String(body?.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: 'Please enter a valid email' }, { status: 400 });
  }
  // One email per address per window, so the form can't be used to spam someone.
  if (checkRateLimit(`pw-reset:${email}`, { maxRequests: 3, windowSeconds: 900 }).success) {
    try {
      const token = await createPasswordResetToken(email);
      if (token) {
        const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin).replace(/\/+$/, '');
        await sendPasswordResetEmail(email, `${baseUrl}/auth/reset-password?token=${token}`);
      }
    } catch (e: any) {
      console.error('[Password reset] request failed:', e?.message);
    }
  }
  return NextResponse.json({ success: true });
}

export async function PUT(request: Request) {
  if (!isPlainPostgres()) {
    return NextResponse.json({ error: 'Password reset is not available' }, { status: 503 });
  }
  if (!checkRateLimit(`pw-reset-confirm:${getClientIdentifier(request)}`, RATE_LIMITS.auth).success) {
    return NextResponse.json({ error: 'Too many requests. Please wait a minute.' }, { status: 429 });
  }
  const body = await request.json().catch(() => ({}));
  const { error } = await resetPasswordWithToken(String(body?.token || ''), String(body?.password || ''));
  if (error) return NextResponse.json({ error }, { status: 400 });
  return NextResponse.json({ success: true });
}
