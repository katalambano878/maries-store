/** Store-local timezone for all printed receipts (Mataheko, Ghana). */
export const STORE_TIMEZONE = 'Africa/Accra';

/** Resolve the sale moment from DB timestamp or the POS order-number prefix. */
export function parsePosOrderTimestamp(input: {
    createdAt?: string | null;
    orderNumber?: string | null;
}): Date {
    if (input.createdAt) {
        const fromDb = new Date(input.createdAt);
        if (!Number.isNaN(fromDb.getTime())) return fromDb;
    }

    const match = String(input.orderNumber || '').match(/^ORD-(\d{10,13})-/);
    if (match) {
        const fromOrderNumber = new Date(Number(match[1]));
        if (!Number.isNaN(fromOrderNumber.getTime())) return fromOrderNumber;
    }

    return new Date();
}

export function formatReceiptDate(date: Date): string {
    return date.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'numeric',
        year: 'numeric',
        timeZone: STORE_TIMEZONE,
    });
}

export function formatReceiptTime(date: Date): string {
    return date.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: STORE_TIMEZONE,
    });
}
