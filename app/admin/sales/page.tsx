'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { parseStorePricingValue } from '@/lib/pricing';

/**
 * Two mutually exclusive pricing modes, stored in site_settings.store_pricing:
 *
 *  - Sale-price mode:  { sales_active: true,  discount_percent: 0, strict_discount: false }
 *      → each product shows its own Sale price; products without one keep regular price.
 *  - Bulk-discount mode: { sales_active: true, discount_percent: N, strict_discount: true }
 *      → N% off the REGULAR price of every product; per-product sale prices are ignored.
 *  - Everything off:   { sales_active: false, discount_percent: 0, strict_discount: false }
 *
 * The UI below only ever writes one of these three shapes, so the two features
 * can never be active at the same time.
 */
export default function AdminSalesPage() {
  const [salesActive, setSalesActive] = useState(false);
  const [discountPercent, setDiscountPercent] = useState(0);
  const [strictDiscount, setStrictDiscount] = useState(false);
  const [customDiscount, setCustomDiscount] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const saleMode = salesActive && !strictDiscount;
  const bulkMode = salesActive && strictDiscount;

  const load = useCallback(async () => {
    setError(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session?.user?.id) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', session.user.id)
          .single();
        setIsAdmin(profile?.role === 'admin');
      } else {
        setIsAdmin(false);
      }

      const { data, error: fetchError } = await supabase
        .from('site_settings')
        .select('id, value')
        .eq('key', 'store_pricing')
        .maybeSingle();

      if (fetchError) {
        setError(fetchError.message);
        setSalesActive(false);
        setDiscountPercent(0);
        setStrictDiscount(false);
        return;
      }

      const parsed = parseStorePricingValue(data?.value);
      setSalesActive(parsed.sales_active);
      setDiscountPercent(parsed.discount_percent);
      setStrictDiscount(parsed.strict_discount);
      if (parsed.discount_percent > 0) {
        setCustomDiscount(String(parsed.discount_percent));
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saveSettings = async (
    next: { sales_active: boolean; discount_percent: number; strict_discount: boolean },
    message: string
  ) => {
    if (!isAdmin) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const { error: upsertError } = await supabase.from('site_settings').upsert(
        {
          key: 'store_pricing',
          value: next,
          category: 'pricing',
        },
        { onConflict: 'key' }
      );
      if (upsertError) throw upsertError;
      setSalesActive(next.sales_active);
      setDiscountPercent(next.discount_percent);
      setStrictDiscount(next.strict_discount);
      if (next.discount_percent > 0) {
        setCustomDiscount(String(next.discount_percent));
      }
      setSuccess(message);
      setTimeout(() => setSuccess(null), 4000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  /** Toggle sale-price mode (turns bulk discount off automatically). */
  const handleSaleToggle = () => {
    if (saleMode) {
      saveSettings(
        { sales_active: false, discount_percent: 0, strict_discount: false },
        'Store-wide sale turned OFF — regular prices everywhere'
      );
    } else {
      saveSettings(
        { sales_active: true, discount_percent: 0, strict_discount: false },
        'Store-wide sale ON — per-product sale prices are now showing'
      );
    }
  };

  /** Activate bulk mode with a percentage (turns sale-price mode off automatically). */
  const activateBulk = (percent: number) => {
    saveSettings(
      { sales_active: true, discount_percent: percent, strict_discount: true },
      `Bulk discount ON — every product now shows ${percent}% off its regular price`
    );
  };

  /** Toggle bulk mode off, or on using the last chosen percentage. */
  const handleBulkToggle = () => {
    if (bulkMode) {
      saveSettings(
        { sales_active: false, discount_percent: 0, strict_discount: false },
        'Bulk discount turned OFF — regular prices everywhere'
      );
      return;
    }
    const pct = discountPercent > 0 ? discountPercent : parseFloat(customDiscount);
    if (isNaN(pct) || pct <= 0 || pct > 100) {
      setError('Pick a percentage first (use a preset or the custom box), then turn this on.');
      return;
    }
    activateBulk(Math.round(pct * 100) / 100);
  };

  const handleCustomDiscountSubmit = () => {
    const val = parseFloat(customDiscount);
    if (isNaN(val) || val <= 0 || val > 100) {
      setError('Please enter a valid percentage between 1 and 100');
      return;
    }
    activateBulk(Math.round(val * 100) / 100);
  };

  const presetDiscounts = [10, 15, 20, 25, 30, 50];

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh] text-gray-500">
        <i className="ri-loader-4-line text-3xl animate-spin mr-2" />
        Loading…
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Sale pricing</h1>
        <p className="text-gray-600 mt-1">
          Two ways to run a promotion — <strong>only one can be on at a time</strong>. Turning one on
          automatically turns the other off.
        </p>
      </div>

      {error && (
        <div className="p-4 rounded-lg bg-red-50 text-red-800 text-sm border border-red-100">{error}</div>
      )}
      {success && (
        <div className="p-4 rounded-lg bg-green-50 border border-green-100 text-green-800 text-sm flex items-center gap-2">
          <i className="ri-checkbox-circle-fill text-green-600" />
          {success}
        </div>
      )}

      {/* Current status banner */}
      <div
        className={`rounded-xl border p-4 text-sm font-medium flex items-center gap-2 ${
          bulkMode
            ? 'bg-purple-50 border-purple-200 text-purple-800'
            : saleMode
              ? 'bg-red-50 border-red-200 text-red-800'
              : 'bg-gray-50 border-gray-200 text-gray-600'
        }`}
      >
        <i
          className={
            bulkMode ? 'ri-percent-fill text-lg' : saleMode ? 'ri-price-tag-3-fill text-lg' : 'ri-pause-circle-line text-lg'
          }
        />
        {bulkMode
          ? `BULK DISCOUNT is running: ${discountPercent}% off the regular price of every product.`
          : saleMode
            ? 'STORE-WIDE SALE is running: products show their own sale prices.'
            : 'No promotion running — all products show regular prices.'}
      </div>

      {!isAdmin && (
        <p className="text-sm text-amber-700 bg-amber-50 px-3 py-2 rounded-lg border border-amber-100">
          Only administrators can change these settings.
        </p>
      )}

      {/* ─── Feature 1: Store-wide sale (per-product sale prices) ─── */}
      <div
        className={`bg-white rounded-xl border-2 shadow-sm p-6 transition-colors ${
          saleMode ? 'border-red-300' : 'border-gray-200'
        }`}
      >
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex-1 min-w-[220px]">
            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              <i className="ri-price-tag-3-line text-red-500" />
              Store-wide sale
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              Shows each product&apos;s <strong>Sale price</strong> (set per product in Products →
              Pricing &amp; Inventory) instead of the regular price. Products without a sale price keep
              their regular price.
            </p>
          </div>
          {isAdmin && (
            <button
              type="button"
              disabled={saving}
              onClick={handleSaleToggle}
              className={`relative inline-flex h-10 w-[3.5rem] shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 ${
                saleMode ? 'bg-red-600' : 'bg-gray-300'
              } ${saving ? 'opacity-60 cursor-wait' : ''}`}
              role="switch"
              aria-checked={saleMode}
            >
              <span
                className={`pointer-events-none inline-block h-9 w-9 transform rounded-full bg-white shadow ring-0 transition ${
                  saleMode ? 'translate-x-[1.4rem]' : 'translate-x-0.5'
                }`}
              />
            </button>
          )}
        </div>
        {bulkMode && (
          <p className="text-xs text-purple-700 bg-purple-50 border border-purple-100 rounded-lg p-2.5 mt-4">
            Bulk discount is currently running. Turning this on will switch it off.
          </p>
        )}
      </div>

      {/* ─── Feature 2: Bulk percentage discount ─── */}
      <div
        className={`bg-white rounded-xl border-2 shadow-sm p-6 transition-colors ${
          bulkMode ? 'border-purple-300' : 'border-gray-200'
        }`}
      >
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex-1 min-w-[220px]">
            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              <i className="ri-percent-line text-purple-500" />
              Bulk percentage discount
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              Takes a flat percentage off the <strong>Regular price of every product</strong>. Ignores
              per-product sale prices completely — one clean discount on everything.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {bulkMode && (
              <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-bold bg-purple-100 text-purple-700">
                {discountPercent}% OFF
              </span>
            )}
            {isAdmin && (
              <button
                type="button"
                disabled={saving}
                onClick={handleBulkToggle}
                className={`relative inline-flex h-10 w-[3.5rem] shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 ${
                  bulkMode ? 'bg-purple-600' : 'bg-gray-300'
                } ${saving ? 'opacity-60 cursor-wait' : ''}`}
                role="switch"
                aria-checked={bulkMode}
              >
                <span
                  className={`pointer-events-none inline-block h-9 w-9 transform rounded-full bg-white shadow ring-0 transition ${
                    bulkMode ? 'translate-x-[1.4rem]' : 'translate-x-0.5'
                  }`}
                />
              </button>
            )}
          </div>
        </div>

        {saleMode && (
          <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg p-2.5 mt-4">
            Store-wide sale is currently running. Picking a percentage below will switch it off.
          </p>
        )}

        {isAdmin && (
          <div className="mt-5 space-y-5">
            {/* Preset discount buttons */}
            <div>
              <p className="text-sm font-medium text-gray-700 mb-3">Quick presets — tap to apply instantly</p>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                {presetDiscounts.map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    disabled={saving}
                    onClick={() => activateBulk(pct)}
                    className={`px-3 py-3 rounded-xl text-sm font-bold transition-all border-2 ${
                      bulkMode && discountPercent === pct
                        ? 'bg-purple-700 text-white border-purple-700 shadow-md scale-[1.02]'
                        : 'bg-white text-gray-700 border-gray-200 hover:border-purple-400 hover:bg-purple-50'
                    } ${saving ? 'opacity-60 cursor-wait' : 'cursor-pointer'}`}
                  >
                    {pct}%
                  </button>
                ))}
              </div>
            </div>

            {/* Custom input */}
            <div>
              <p className="text-sm font-medium text-gray-700 mb-3">Custom percentage</p>
              <div className="flex items-center gap-3">
                <div className="relative flex-1 max-w-[200px]">
                  <input
                    type="number"
                    min="1"
                    max="100"
                    step="1"
                    value={customDiscount}
                    onChange={(e) => setCustomDiscount(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCustomDiscountSubmit();
                    }}
                    placeholder="e.g. 12"
                    className="w-full pl-4 pr-10 py-3 border-2 border-gray-200 rounded-xl text-sm font-medium focus:ring-2 focus:ring-purple-500 focus:border-purple-500 transition-all"
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 font-bold text-sm">%</span>
                </div>
                <button
                  type="button"
                  disabled={saving || !customDiscount}
                  onClick={handleCustomDiscountSubmit}
                  className="px-5 py-3 bg-purple-700 text-white rounded-xl font-semibold text-sm hover:bg-purple-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap cursor-pointer"
                >
                  {saving ? <i className="ri-loader-4-line animate-spin" /> : 'Apply'}
                </button>
              </div>
            </div>
          </div>
        )}

        {isAdmin && (
          <div className="mt-5 pt-4 border-t border-gray-100">
            <p className="text-xs text-gray-500">
              <strong>Example at 50%:</strong> a product with a regular price of GH₵40.00 becomes
              GH₵20.00 — even if it has its own sale price of GH₵35.00. The crossed-out &ldquo;was&rdquo;
              price customers see is always the regular price.
            </p>
          </div>
        )}
      </div>

      <p className="text-xs text-gray-500">
        Tip: After changing anything here, refresh the storefront if you have it open. Checkout and the
        POS always charge using the rule that is active at that moment.
      </p>
    </div>
  );
}
