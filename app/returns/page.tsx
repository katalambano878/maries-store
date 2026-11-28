'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { thumbSrc } from '@/lib/image-src';
import { fetchOrder } from '@/lib/fetch-order';

type OrderItem = {
  id: string;
  product_name: string;
  variant_name: string | null;
  quantity: number;
  unit_price: number;
  metadata?: { image?: string } | null;
  products?: { product_images?: { url: string }[] } | null;
};

type FoundOrder = {
  order_number: string;
  created_at: string;
  payment_status: string;
  order_items: OrderItem[];
};

const REASONS = [
  'Wrong item received',
  'Defective or damaged item',
  'Not as described',
  'Wrong colour or length',
  'Changed my mind',
  'Other',
];

function itemImage(item: OrderItem): string {
  return item.metadata?.image || item.products?.product_images?.[0]?.url || '';
}

export default function ReturnsPortalPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [orderNumber, setOrderNumber] = useState('');
  const [contact, setContact] = useState('');
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [returnReasons, setReturnReasons] = useState<Record<string, string>>({});
  const [returnType, setReturnType] = useState<'refund' | 'exchange'>('refund');
  const [details, setDetails] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [foundOrder, setFoundOrder] = useState<FoundOrder | null>(null);

  const handleFindOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const ref = orderNumber.trim().replace(/-r[a-z0-9]+$/i, '');
    const value = contact.trim();
    if (!ref || !value) {
      setError('Enter your order number and the email or phone you used at checkout.');
      return;
    }
    setIsLoading(true);
    try {
      const order = await fetchOrder(ref, {
        tracking: true,
        ...(value.includes('@') ? { email: value.toLowerCase() } : { phone: value }),
      });
      if (!order) {
        setError('We could not find that order with those details. Check the order number on your receipt.');
        return;
      }
      if (order.payment_status !== 'paid') {
        setError('This order has not been paid, so there is nothing to return. Contact us if you need help.');
        return;
      }
      setFoundOrder(order);
      setOrderNumber(ref);
      setSelectedItems([]);
      setReturnReasons({});
      setStep(2);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleItemSelection = (itemId: string) => {
    setSelectedItems(prev => (prev.includes(itemId) ? prev.filter(id => id !== itemId) : [...prev, itemId]));
  };

  const handleSubmitReturn = async () => {
    if (!foundOrder) return;
    setIsLoading(true);
    setError('');
    try {
      const res = await fetch('/api/returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderNumber,
          contact: contact.trim(),
          type: returnType,
          details,
          items: foundOrder.order_items
            .filter(item => selectedItems.includes(item.id))
            .map(item => ({ orderItemId: item.id, quantity: item.quantity, reason: returnReasons[item.id] })),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.error || 'Could not send the return request. Please try again.');
        return;
      }
      router.push(`/returns/confirmation?order=${encodeURIComponent(orderNumber)}`);
    } finally {
      setIsLoading(false);
    }
  };

  const chosen = foundOrder?.order_items.filter(item => selectedItems.includes(item.id)) || [];

  return (
    <main className="min-h-screen bg-gray-50 py-12">
      <div className="max-w-4xl mx-auto px-4">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Returns</h1>
        <p className="text-gray-600 mb-8">Ask for a refund or exchange on a paid order</p>

        <div className="mb-8">
          <div className="flex items-center justify-between">
            {[1, 2, 3].map(i => (
              <div key={i} className="flex items-center flex-1 last:flex-none">
                <div
                  className={`w-10 h-10 flex items-center justify-center rounded-full font-bold ${
                    i <= step ? 'bg-stone-800 text-white' : 'bg-gray-200 text-gray-500'
                  }`}
                >
                  {i < step ? <i className="ri-check-line"></i> : i}
                </div>
                {i < 3 && <div className={`flex-1 h-1 mx-4 ${i < step ? 'bg-stone-800' : 'bg-gray-200'}`}></div>}
              </div>
            ))}
          </div>
          <div className="flex justify-between mt-2">
            <span className="text-sm font-semibold text-gray-900">Find order</span>
            <span className="text-sm font-semibold text-gray-900">Choose items</span>
            <span className="text-sm font-semibold text-gray-900">Send</span>
          </div>
        </div>

        {error && <div className="mb-6 p-4 rounded-xl bg-red-50 text-red-700 border border-red-100 text-sm">{error}</div>}

        {step === 1 && (
          <div className="bg-white rounded-xl shadow-sm p-8">
            <h2 className="text-2xl font-bold text-gray-900 mb-6">Find your order</h2>
            <form onSubmit={handleFindOrder} className="space-y-6">
              <div>
                <label className="block text-sm font-semibold text-gray-900 mb-2">Order number *</label>
                <input
                  type="text"
                  value={orderNumber}
                  onChange={e => setOrderNumber(e.target.value)}
                  placeholder="ORD-1795776740411-755"
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-stone-700 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-900 mb-2">Email or phone used at checkout *</label>
                <input
                  type="text"
                  value={contact}
                  onChange={e => setContact(e.target.value)}
                  placeholder="054 123 4567"
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-stone-700 focus:border-transparent"
                />
              </div>
              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-4 bg-stone-800 hover:bg-stone-900 text-white rounded-lg font-semibold transition-colors disabled:opacity-50"
              >
                {isLoading ? 'Finding order…' : 'Find order'}
              </button>
            </form>
          </div>
        )}

        {step === 2 && foundOrder && (
          <div className="bg-white rounded-xl shadow-sm p-8">
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Choose the items</h2>
            <p className="text-sm text-gray-600 mb-6">
              Order {foundOrder.order_number} · {new Date(foundOrder.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
            </p>

            <div className="space-y-4 mb-8">
              {foundOrder.order_items.map(item => {
                const selected = selectedItems.includes(item.id);
                const image = itemImage(item);
                return (
                  <div key={item.id} className={`p-4 rounded-lg border-2 ${selected ? 'border-stone-800 bg-stone-50' : 'border-gray-200'}`}>
                    <label className="flex items-start gap-4 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleItemSelection(item.id)}
                        className="mt-1 w-5 h-5"
                      />
                      <div className="w-16 h-16 bg-gray-100 rounded-lg overflow-hidden flex-shrink-0">
                        {image && <img src={thumbSrc(image, 128)} alt={item.product_name} className="w-full h-full object-cover" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-gray-900">{item.product_name}</p>
                        {item.variant_name && <p className="text-sm text-gray-600">{item.variant_name}</p>}
                        <p className="text-sm text-gray-600">Qty {item.quantity} · GH₵{Number(item.unit_price).toFixed(2)}</p>
                      </div>
                    </label>
                    {selected && (
                      <select
                        value={returnReasons[item.id] || ''}
                        onChange={e => setReturnReasons({ ...returnReasons, [item.id]: e.target.value })}
                        className="mt-3 w-full px-4 py-3 border border-gray-300 rounded-lg"
                      >
                        <option value="">Select a reason</option>
                        {REASONS.map(reason => (
                          <option key={reason} value={reason}>{reason}</option>
                        ))}
                      </select>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mb-8">
              <p className="block text-sm font-semibold text-gray-900 mb-3">What would you like?</p>
              <div className="grid grid-cols-2 gap-4">
                {(['refund', 'exchange'] as const).map(kind => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => setReturnType(kind)}
                    className={`p-4 rounded-lg border-2 text-left transition-all ${
                      returnType === kind ? 'border-stone-800 bg-stone-50' : 'border-gray-300 hover:border-gray-400'
                    }`}
                  >
                    <p className="font-semibold text-gray-900">{kind === 'refund' ? 'Refund' : 'Exchange'}</p>
                    <p className="text-sm text-gray-600 mt-1">
                      {kind === 'refund' ? 'Money back for the item' : 'Swap for another colour, length or item'}
                    </p>
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-8">
              <label className="block text-sm font-semibold text-gray-900 mb-2">Anything else we should know? (optional)</label>
              <textarea
                value={details}
                onChange={e => setDetails(e.target.value)}
                rows={3}
                maxLength={2000}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg"
              />
            </div>

            <div className="flex gap-4">
              <button
                onClick={() => setStep(1)}
                className="flex-1 py-4 border-2 border-gray-300 text-gray-700 rounded-lg font-semibold hover:bg-gray-50"
              >
                Back
              </button>
              <button
                onClick={() => setStep(3)}
                disabled={selectedItems.length === 0 || !selectedItems.every(id => returnReasons[id])}
                className="flex-1 py-4 bg-stone-800 hover:bg-stone-900 text-white rounded-lg font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {step === 3 && foundOrder && (
          <div className="bg-white rounded-xl shadow-sm p-8">
            <h2 className="text-2xl font-bold text-gray-900 mb-6">Check and send</h2>
            <div className="space-y-3 mb-6">
              {chosen.map(item => (
                <div key={item.id} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                  <div>
                    <p className="font-semibold text-gray-900">{item.product_name}</p>
                    <p className="text-sm text-gray-600">Reason: {returnReasons[item.id]}</p>
                  </div>
                  <p className="font-bold text-gray-900">GH₵{(Number(item.unit_price) * item.quantity).toFixed(2)}</p>
                </div>
              ))}
            </div>
            <p className="text-sm text-gray-600 mb-8">
              You are asking for {returnType === 'refund' ? 'a refund' : 'an exchange'}. The shop will contact you to arrange the next step.
            </p>
            <div className="flex gap-4">
              <button
                onClick={() => setStep(2)}
                className="flex-1 py-4 border-2 border-gray-300 text-gray-700 rounded-lg font-semibold hover:bg-gray-50"
              >
                Back
              </button>
              <button
                onClick={handleSubmitReturn}
                disabled={isLoading}
                className="flex-1 py-4 bg-stone-800 hover:bg-stone-900 text-white rounded-lg font-semibold disabled:opacity-50"
              >
                {isLoading ? 'Sending…' : 'Send return request'}
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
