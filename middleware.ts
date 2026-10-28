import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

/**
 * Check the admin session cookie: a store-issued access token (see
 * lib/db/auth.ts) whose app_metadata.role is admin or staff. Data access is
 * still enforced per request by row-level security; this only keeps the
 * dashboard shell away from shoppers.
 */
async function verifyStaffToken(token: string): Promise<{ userId: string; role: string } | null> {
    const secret = process.env.AUTH_JWT_SECRET || process.env.JWT_SECRET;
    if (!secret) return null;
    try {
        const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
        if (payload.typ === 'refresh' || typeof payload.sub !== 'string') return null;
        const role = (payload.app_metadata as { role?: string } | undefined)?.role;
        if (role !== 'admin' && role !== 'staff') return null;
        return { userId: payload.sub, role };
    } catch {
        return null;
    }
}

export async function middleware(request: NextRequest) {
    const { pathname } = request.nextUrl;
    const response = NextResponse.next();

    // ============================================================
    // Security headers for ALL routes
    // ============================================================
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

    // ============================================================
    // Admin route protection
    // ============================================================
    if (pathname.startsWith('/admin')) {
        // Security headers for admin
        response.headers.set('X-Robots-Tag', 'noindex, nofollow');
        response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');

        // Allow login page without auth
        if (pathname === '/admin/login') {
            return response;
        }

        // The admin login page sets 'sb-access-token' after signing in.
        const token = request.cookies.get('sb-access-token')?.value;

        if (!token) {
            // No auth token found — redirect to login
            const loginUrl = new URL('/admin/login', request.url);
            loginUrl.searchParams.set('redirect', pathname);
            return NextResponse.redirect(loginUrl);
        }

        const verified = await verifyStaffToken(token);
        if (!verified) {
            const loginUrl = new URL('/admin/login', request.url);
            loginUrl.searchParams.set('redirect', pathname);
            loginUrl.searchParams.set('error', 'session_expired');
            return NextResponse.redirect(loginUrl);
        }
        response.headers.set('x-user-id', verified.userId);
        response.headers.set('x-user-role', verified.role);
    }

    // ============================================================
    // API route security headers
    // ============================================================
    if (pathname.startsWith('/api/')) {
        response.headers.set('X-Content-Type-Options', 'nosniff');
        response.headers.set('Cache-Control', 'no-store');
    }

    return response;
}

export const config = {
    matcher: [
        '/admin/:path*',
        '/api/:path*',
    ],
};
