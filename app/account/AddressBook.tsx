'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { GHANA_REGIONS } from '@/lib/ghana-regions';

interface Address {
  id: string;
  full_name: string;
  phone: string;
  address_line1: string;
  city: string;
  state: string;
  is_default: boolean;
}

type AddressForm = Omit<Address, 'id'>;

const EMPTY_FORM: AddressForm = {
  full_name: '',
  phone: '',
  address_line1: '',
  city: '',
  state: '',
  is_default: false,
};

const inputClass =
  'w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-700 focus:border-transparent';

export default function AddressBook() {
  const [userId, setUserId] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<AddressForm>(EMPTY_FORM);

  const load = useCallback(async (uid: string) => {
    const { data, error: loadError } = await supabase
      .from('addresses')
      .select('id, full_name, phone, address_line1, city, state, is_default')
      .eq('user_id', uid)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true });
    if (loadError) setError('Could not load your addresses.');
    setAddresses((data as Address[]) || []);
  }, []);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        setUserId(session.user.id);
        await load(session.user.id);
      }
      setLoading(false);
    })();
  }, [load]);

  const openNew = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, is_default: addresses.length === 0 });
    setError('');
    setShowForm(true);
  };

  const openEdit = (address: Address) => {
    setEditingId(address.id);
    setForm({
      full_name: address.full_name,
      phone: address.phone,
      address_line1: address.address_line1,
      city: address.city,
      state: address.state,
      is_default: address.is_default,
    });
    setError('');
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  // Only one default per customer.
  const clearOtherDefaults = async (keepId: string) => {
    if (!userId) return;
    await supabase
      .from('addresses')
      .update({ is_default: false })
      .eq('user_id', userId)
      .neq('id', keepId);
  };

  const saveAddress = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId) return;
    const values = {
      full_name: form.full_name.trim(),
      phone: form.phone.trim(),
      address_line1: form.address_line1.trim(),
      city: form.city.trim(),
      state: form.state,
    };
    if (!values.full_name || !values.phone || !values.address_line1 || !values.city || !values.state) {
      setError('Fill in every field to save the address.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const id = editingId || crypto.randomUUID();
      const row = { ...values, is_default: form.is_default };
      const { error: saveError } = editingId
        ? await supabase.from('addresses').update(row).eq('id', editingId)
        : await supabase.from('addresses').insert({
            ...row,
            id,
            user_id: userId,
            type: 'shipping',
            postal_code: '',
            country: 'Ghana',
          });
      if (saveError) throw saveError;
      if (form.is_default) await clearOtherDefaults(id);
      await load(userId);
      closeForm();
    } catch (err) {
      console.error('Saving address failed:', err);
      setError('Could not save the address. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const deleteAddress = async (id: string) => {
    if (!userId || !confirm('Delete this address?')) return;
    const { error: deleteError } = await supabase.from('addresses').delete().eq('id', id);
    if (deleteError) {
      setError('Could not delete the address.');
      return;
    }
    await load(userId);
  };

  const setDefault = async (id: string) => {
    if (!userId) return;
    const { error: updateError } = await supabase.from('addresses').update({ is_default: true }).eq('id', id);
    if (updateError) {
      setError('Could not change the default address.');
      return;
    }
    await clearOtherDefaults(id);
    await load(userId);
  };

  if (loading) {
    return (
      <div className="py-8 text-center">
        <i className="ri-loader-4-line animate-spin text-3xl text-blue-700"></i>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6 gap-4">
        <h2 className="text-2xl font-bold text-gray-900">Address Book</h2>
        {!showForm && (
          <button
            onClick={openNew}
            className="px-4 py-2 bg-blue-700 text-white rounded-lg font-semibold hover:bg-blue-800 transition-colors whitespace-nowrap"
          >
            <i className="ri-add-line mr-2"></i>
            Add New Address
          </button>
        )}
      </div>

      {error && (
        <div className="mb-6 p-4 rounded-xl bg-red-50 text-red-700 border border-red-100 text-sm">{error}</div>
      )}

      {showForm && (
        <div className="bg-white border-2 border-blue-700 rounded-lg p-6 mb-6">
          <h3 className="text-xl font-bold text-gray-900 mb-4">
            {editingId ? 'Edit Address' : 'New Address'}
          </h3>
          <form onSubmit={saveAddress} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-gray-900 mb-2">Full Name</label>
              <input
                type="text"
                value={form.full_name}
                onChange={e => setForm({ ...form, full_name: e.target.value })}
                className={inputClass}
                autoComplete="name"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-900 mb-2">Phone Number</label>
              <input
                type="tel"
                value={form.phone}
                onChange={e => setForm({ ...form, phone: e.target.value })}
                className={inputClass}
                placeholder="054 123 4567"
                autoComplete="tel"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-semibold text-gray-900 mb-2">Street Address</label>
              <input
                type="text"
                value={form.address_line1}
                onChange={e => setForm({ ...form, address_line1: e.target.value })}
                className={inputClass}
                autoComplete="street-address"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-900 mb-2">City / Town</label>
              <input
                type="text"
                value={form.city}
                onChange={e => setForm({ ...form, city: e.target.value })}
                className={inputClass}
                autoComplete="address-level2"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-900 mb-2">Region</label>
              <select
                value={form.state}
                onChange={e => setForm({ ...form, state: e.target.value })}
                className={inputClass}
              >
                <option value="">Select region</option>
                {GHANA_REGIONS.map(region => (
                  <option key={region} value={region}>{region}</option>
                ))}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={form.is_default}
                  onChange={e => setForm({ ...form, is_default: e.target.checked })}
                  className="w-4 h-4 text-blue-700 border-gray-300 rounded focus:ring-blue-700"
                />
                <span className="ml-2 text-sm text-gray-700">Use this address at checkout</span>
              </label>
            </div>
            <div className="md:col-span-2 flex flex-col sm:flex-row space-y-3 sm:space-y-0 sm:space-x-3">
              <button
                type="submit"
                disabled={saving}
                className="flex-1 py-3 bg-blue-700 text-white rounded-lg font-semibold hover:bg-blue-800 transition-colors whitespace-nowrap disabled:opacity-60"
              >
                {saving ? 'Saving…' : 'Save Address'}
              </button>
              <button
                type="button"
                onClick={closeForm}
                className="flex-1 py-3 border-2 border-gray-300 text-gray-900 rounded-lg font-semibold hover:bg-gray-50 transition-colors whitespace-nowrap"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {addresses.length === 0 && !showForm ? (
        <div className="py-12 text-center bg-white rounded-lg border border-gray-200">
          <i className="ri-map-pin-line text-4xl text-gray-300"></i>
          <p className="mt-3 text-gray-600">No saved addresses yet.</p>
          <p className="text-sm text-gray-500">Add one here, or tick “Save this address” at checkout.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {addresses.map(address => (
            <div
              key={address.id}
              className={`bg-white border-2 rounded-lg p-6 ${address.is_default ? 'border-blue-700' : 'border-gray-200'}`}
            >
              {address.is_default && (
                <span className="inline-block px-3 py-1 bg-blue-700 text-white text-xs font-semibold rounded-full mb-3">
                  Default
                </span>
              )}
              <h3 className="font-bold text-gray-900 mb-2">{address.full_name}</h3>
              <p className="text-gray-700 text-sm mb-1">{address.phone}</p>
              <p className="text-gray-700 text-sm mb-1">{address.address_line1}</p>
              <p className="text-gray-700 text-sm mb-4">{address.city}, {address.state}</p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => openEdit(address)}
                  className="px-4 py-2 border-2 border-gray-300 text-gray-900 rounded-lg text-sm font-semibold hover:bg-gray-50 transition-colors"
                >
                  Edit
                </button>
                {!address.is_default && (
                  <button
                    onClick={() => setDefault(address.id)}
                    className="px-4 py-2 border-2 border-gray-300 text-gray-900 rounded-lg text-sm font-semibold hover:bg-gray-50 transition-colors"
                  >
                    Set as Default
                  </button>
                )}
                <button
                  onClick={() => deleteAddress(address.id)}
                  className="px-4 py-2 border-2 border-red-200 text-red-600 rounded-lg text-sm font-semibold hover:bg-red-50 transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
