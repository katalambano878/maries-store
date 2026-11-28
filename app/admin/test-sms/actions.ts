'use server';

import { verifyAdminToken } from '@/lib/auth';
import { sendSMS } from '@/lib/notifications';

export async function testSmsAction(phone: string, message: string, authToken: string) {
    // SECURITY: Verify admin authentication before allowing SMS sending
    const auth = await verifyAdminToken(authToken);
    if (!auth.authenticated) {
        return {
            success: false,
            error: 'Unauthorized: ' + (auth.error || 'Admin access required')
        };
    }

    // Validate phone input
    if (!phone || typeof phone !== 'string') {
        return { success: false, error: 'Invalid phone number' };
    }

    // Validate message input
    if (!message || typeof message !== 'string' || message.length > 1000) {
        return { success: false, error: 'Invalid or too long message' };
    }

    try {
        console.log('[Test SMS] Sent by user:', auth.user?.email);
        const result = await sendSMS({ to: phone, message });
        if (!result) {
            return { success: false, error: 'SMS is not connected or the number is not valid' };
        }
        return {
            success: result.status === 1,
            result,
            error: result.status === 1 ? undefined : (result as { error?: string }).error,
        };
    } catch (error: any) {
        // SECURITY: Don't expose stack traces
        console.error('[Test SMS] Error:', error.message);
        return {
            success: false,
            error: error.message || 'SMS sending failed'
        };
    }
}
