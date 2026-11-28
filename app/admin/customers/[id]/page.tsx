'use client';

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { isRealEmail } from '@/lib/admin-customers';

export default function CustomerDetailsPage() {
    const params = useParams();
    const customerId = params.id as string;
    
    const [customer, setCustomer] = useState<any>(null);
    const [orders, setOrders] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchCustomerData = useCallback(async () => {
        try {
            const id = decodeURIComponent(customerId);
            const fromOrders = (list: any[], fallback: { email?: string; phone?: string }) => {
                const latest = list[0];
                const first = latest?.metadata?.first_name || latest?.shipping_address?.firstName || '';
                const last = latest?.metadata?.last_name || latest?.shipping_address?.lastName || '';
                return {
                    email: isRealEmail(latest?.email) ? latest.email : fallback.email || '',
                    full_name: `${first} ${last}`.trim() || 'Guest',
                    phone: latest?.phone || latest?.shipping_address?.phone || fallback.phone || null,
                    created_at: list[list.length - 1]?.created_at,
                };
            };

            // Guests (no account) are keyed by phone, or by email when there is no phone.
            const phoneMatch = /^phone-(\d{9})$/.exec(id);
            const emailMatch = /^email-(.+)$/.exec(id) || /^guest-\d+-(.+)$/.exec(id);
            if (phoneMatch || emailMatch) {
                const { data: found, error: guestError } = phoneMatch
                    ? await supabase.from('orders').select('*').ilike('phone', `%${phoneMatch[1]}%`).order('created_at', { ascending: false })
                    : await supabase.from('orders').select('*').eq('email', emailMatch![1]).order('created_at', { ascending: false });
                if (guestError) throw guestError;
                const guestOrders = (found || []).filter((o: any) => !o.user_id);
                if (guestOrders.length) {
                    setCustomer(fromOrders(guestOrders, { phone: phoneMatch ? `0${phoneMatch[1]}` : undefined, email: emailMatch?.[1] }));
                    setOrders(guestOrders);
                }
                return;
            }

            const { data: profile, error: profileError } = await supabase
                .from('profiles')
                .select('*')
                .eq('id', id)
                .single();
            if (profileError) throw profileError;

            const { data: ordersData } = await supabase
                .from('orders')
                .select('*')
                .eq('user_id', id)
                .order('created_at', { ascending: false });

            setCustomer(profile);
            setOrders(ordersData || []);
        } catch (err) {
            console.error('Error fetching customer:', err);
        } finally {
            setLoading(false);
        }
    }, [customerId]);

    useEffect(() => {
        if (customerId) {
            fetchCustomerData();
        }
    }, [customerId, fetchCustomerData]);

    if (loading) return <div className="p-8 text-center text-gray-500">Loading customer details...</div>;
    if (!customer) return <div className="p-8 text-center text-red-500">Customer not found</div>;

    const paidOrders = orders.filter(order => order.payment_status === 'paid' && order.status !== 'cancelled');
    const totalSpent = paidOrders.reduce((sum, order) => sum + (Number(order.total) || 0), 0);
    const phoneDigits = String(customer.phone || '').replace(/\D/g, '').slice(-9);

    return (
        <div className="max-w-7xl mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between mb-8">
                <div className="flex items-center space-x-4">
                    <Link href="/admin/customers" className="p-2 hover:bg-gray-100 rounded-lg text-gray-500 transition-colors">
                        <i className="ri-arrow-left-line text-xl"></i>
                    </Link>
                    <div className="w-16 h-16 bg-stone-100 rounded-full flex items-center justify-center text-stone-700 text-2xl font-bold">
                        {(customer.full_name || customer.email || '?').charAt(0).toUpperCase()}
                    </div>
                    <div>
                        <h1 className="text-3xl font-bold text-gray-900">{customer.full_name || 'No Name'}</h1>
                        <p className="text-gray-500">{isRealEmail(customer.email) ? customer.email : 'No email'}</p>
                    </div>
                </div>
                <div className="flex space-x-3">
                    {isRealEmail(customer.email) && (
                        <a href={`mailto:${customer.email}`} className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50">
                            <i className="ri-mail-send-line mr-2"></i>
                            Send Email
                        </a>
                    )}
                    {phoneDigits.length === 9 && (
                        <a
                            href={`https://wa.me/233${phoneDigits}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-4 py-2 bg-stone-600 text-white rounded-lg font-bold hover:bg-stone-700"
                        >
                            <i className="ri-whatsapp-line mr-2"></i>
                            WhatsApp
                        </a>
                    )}
                </div>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                    <p className="text-sm font-medium text-gray-500 mb-1">Total Spent</p>
                    <p className="text-2xl font-bold text-gray-900">GH₵{totalSpent.toFixed(2)}</p>
                </div>
                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                    <p className="text-sm font-medium text-gray-500 mb-1">Paid Orders</p>
                    <p className="text-2xl font-bold text-gray-900">{paidOrders.length}</p>
                </div>
                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                    <p className="text-sm font-medium text-gray-500 mb-1">Last Order</p>
                    <p className="text-xl font-bold text-gray-900">
                        {orders[0] ? new Date(orders[0].created_at).toLocaleDateString() : 'Never'}
                    </p>
                </div>
                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                    <p className="text-sm font-medium text-gray-500 mb-1">Phone</p>
                    <p className="text-lg font-bold text-gray-900">{customer.phone || 'N/A'}</p>
                </div>
            </div>

            {/* Orders History */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-200">
                    <h2 className="text-lg font-bold text-gray-900">Order History</h2>
                </div>

                {orders.length === 0 ? (
                    <div className="p-8 text-center text-gray-500">No orders found.</div>
                ) : (
                    <table className="w-full text-left">
                        <thead className="bg-gray-50 text-gray-600 text-xs uppercase font-semibold">
                            <tr>
                                <th className="px-6 py-4">Order ID</th>
                                <th className="px-6 py-4">Date</th>
                                <th className="px-6 py-4">Status</th>
                                <th className="px-6 py-4">Total</th>
                                <th className="px-6 py-4 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {orders.map(order => (
                                <tr key={order.id} className="hover:bg-gray-50">
                                    <td className="px-6 py-4 text-sm font-medium text-stone-600">
                                        <Link href={`/admin/orders/${order.id}`}>{order.order_number || `#${order.id.slice(0, 8)}`}</Link>
                                        {order.payment_status !== 'paid' && (
                                            <span className="ml-2 text-xs text-gray-400">unpaid</span>
                                        )}
                                    </td>
                                    <td className="px-6 py-4 text-sm text-gray-600">
                                        {new Date(order.created_at).toLocaleDateString()}
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize
                                            ${order.status === 'completed' || order.status === 'delivered' ? 'bg-stone-100 text-stone-800' :
                                                order.status === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                                                    order.status === 'cancelled' ? 'bg-red-100 text-red-800' : 'bg-stone-100 text-stone-800'}`}>
                                            {order.status === 'shipped' ? 'Packaged' : order.status.replace('_', ' ')}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 text-sm font-bold text-gray-900">
                                        GH₵{(Number(order.total) || 0).toFixed(2)}
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        <Link href={`/admin/orders/${order.id}`} className="text-gray-400 hover:text-stone-600">
                                            <i className="ri-eye-line text-lg"></i>
                                        </Link>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}
