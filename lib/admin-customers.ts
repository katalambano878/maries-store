/**
 * Admin customer list, built from accounts and paid orders.
 *
 * The `customers` table stopped filling after the move off Supabase (its
 * upsert only runs for the server role), so the admin reads people straight
 * from orders: a signed-in order belongs to its account, a guest order to its
 * phone number (guests get a throwaway email per order), else its email.
 */

export type AdminCustomer = {
  id: string;
  name: string;
  email: string;
  phone: string;
  orders: number;
  totalSpent: number;
  firstSeen: Date;
  lastOrder: Date | null;
  status: 'VIP' | 'Active' | 'New';
  isGuest: boolean;
};

export const VIP_SPEND = 1000;

/** Ghana numbers compared by their last 9 digits (054…, 23354…, +233 54…). */
export function phoneKey(raw: string | null | undefined): string {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : '';
}

export function isRealEmail(email: string | null | undefined): boolean {
  const value = String(email || '').trim().toLowerCase();
  return (
    /\S+@\S+\.\S+/.test(value) &&
    !/^guest-\d+@shopmarieshair\.com$/.test(value) &&
    !value.endsWith('@store.local') &&
    !value.endsWith('@pos.local') &&
    !value.endsWith('@noemail.local')
  );
}

/** Stable id for the detail page: account id, `phone-<9 digits>` or `email-<address>`. */
export function customerIdForOrder(order: { user_id?: string | null; phone?: string | null; email?: string | null; shipping_address?: any }): string | null {
  if (order.user_id) return order.user_id;
  const phone = phoneKey(order.phone || order.shipping_address?.phone);
  if (phone) return `phone-${phone}`;
  if (isRealEmail(order.email)) return `email-${String(order.email).toLowerCase()}`;
  return null; // POS walk-in with no contact
}

function orderName(order: any): string {
  const a = order.shipping_address || {};
  const first = a.firstName || order.metadata?.first_name || '';
  const last = a.lastName || order.metadata?.last_name || '';
  return (a.full_name || `${first} ${last}`).trim();
}

export function buildCustomers(profiles: any[], orders: any[]): AdminCustomer[] {
  const byId = new Map<string, AdminCustomer>();

  for (const p of profiles) {
    if (p.role === 'admin' || p.role === 'staff') continue;
    byId.set(p.id, {
      id: p.id,
      name: p.full_name || '',
      email: p.email || '',
      phone: p.phone || '',
      orders: 0,
      totalSpent: 0,
      firstSeen: new Date(p.created_at),
      lastOrder: null,
      status: 'New',
      isGuest: false,
    });
  }

  // Newest first, so names and phones come from the latest order.
  const sorted = [...orders].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  for (const order of sorted) {
    if (order.payment_status !== 'paid' || order.status === 'cancelled') continue;
    const id = customerIdForOrder(order);
    if (!id) continue;
    const created = new Date(order.created_at);
    let c = byId.get(id);
    if (!c) {
      if (order.user_id) continue; // account deleted
      c = {
        id,
        name: '',
        email: isRealEmail(order.email) ? order.email : '',
        phone: order.phone || order.shipping_address?.phone || '',
        orders: 0,
        totalSpent: 0,
        firstSeen: created,
        lastOrder: null,
        status: 'New',
        isGuest: true,
      };
      byId.set(id, c);
    }
    c.orders += 1;
    c.totalSpent += Number(order.total) || 0;
    if (!c.lastOrder || created > c.lastOrder) c.lastOrder = created;
    if (created < c.firstSeen) c.firstSeen = created;
    if (!c.name) c.name = orderName(order);
    if (!c.phone) c.phone = order.phone || order.shipping_address?.phone || '';
    if (!c.email && isRealEmail(order.email)) c.email = order.email;
  }

  return [...byId.values()].map(c => ({
    ...c,
    name: c.name || (c.isGuest ? 'Guest' : 'No name'),
    status: c.totalSpent > VIP_SPEND ? 'VIP' : c.orders > 0 ? 'Active' : 'New',
  }));
}

export function customersCsv(list: (AdminCustomer | (Omit<AdminCustomer, 'lastOrder'> & { lastOrder: unknown; rawLastOrder?: Date | null }))[]): string {
  const lastDate = (c: any): string => {
    const d = c.rawLastOrder ?? c.lastOrder;
    return d instanceof Date ? d.toISOString().slice(0, 10) : '';
  };
  const cell = (v: string | number) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [
    ['Name', 'Email', 'Phone', 'Paid orders', 'Total spent (GHS)', 'Last order', 'Status', 'Type'],
    ...list.map(c => [
      c.name,
      c.email,
      c.phone,
      c.orders,
      c.totalSpent.toFixed(2),
      lastDate(c),
      c.status,
      c.isGuest ? 'Guest' : 'Account',
    ]),
  ];
  return rows.map(r => r.map(cell).join(',')).join('\n');
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
