'use client';

import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import {
    parseStorePricingValue,
    resolveCartLineUnitPrice,
    resolveProductPrice,
    resolveVariantPrice,
} from '@/lib/pricing';

interface PosVariant {
    id: string;
    /** Matches `resolveCartLineUnitPrice` matching (option2 / name or single name) */
    label: string;
    displayName: string;
    /** `product_variants.name` — used for order_items.variant_name / stock reduction */
    rawName: string;
    price: number;
    quantity: number;
    sku: string | null;
}

interface Product {
    id: string;
    name: string;
    price: number;
    quantity: number;
    category: string;
    image: string;
    sku: string;
    slug?: string;
    hasVariants: boolean;
    variants: PosVariant[];
}

interface CartItem extends Product {
    cartQuantity: number;
    lineKey: string;
    variantId?: string | null;
    /** Label for `resolveCartLineUnitPrice` */
    variant?: string | null;
    variantSku?: string | null;
    variantDisplay?: string | null;
    /** DB `product_variants.name` for order_items + stock RPC */
    variantRawName?: string | null;
}

interface Customer {
    id: string;
    full_name: string;
    email: string;
    phone?: string;
}

function categoryNameFromRow(categories: unknown): string {
    if (!categories) return 'Uncategorized';
    if (Array.isArray(categories)) return categories[0]?.name || 'Uncategorized';
    return (categories as { name?: string }).name || 'Uncategorized';
}

/** Escape LIKE wildcards so user input doesn't break ilike patterns */
function escapeIlike(s: string): string {
    return s.replace(/[%_\\]/g, '\\$&');
}

/** Label must stay consistent with `resolveCartLineUnitPrice` in lib/pricing.ts */
function buildVariantLabel(v: { name: string; option2?: string | null }): string {
    const n = (v.name || '').trim();
    const o2 = (v.option2 || '').trim();
    if (o2 && n) return `${o2} / ${n}`;
    return n || o2 || 'Variant';
}

function variantDisplayName(v: { name: string; option1?: string | null; option2?: string | null }): string {
    const parts = [v.option1, v.option2, v.name].filter(Boolean).map((s) => String(s).trim());
    const uniq = [...new Set(parts)];
    return uniq.join(' · ') || (v.name || '').trim() || 'Variant';
}

function formatPosProduct(
    p: any,
    salesActive: boolean,
    discountPercent: number
): Product {
    const rawVariants = p.product_variants || [];
    const variants: PosVariant[] = rawVariants.map((v: any) => {
        const eff = resolveVariantPrice({
            salesActive,
            productPrice: p.price,
            productSalePrice: p.sale_price,
            variantPrice: Number(v.price ?? p.price),
            variantSalePrice: v.sale_price,
            compareAtPrice: p.compare_at_price,
            discountPercent,
        }).effective;
        return {
            id: v.id,
            label: buildVariantLabel(v),
            displayName: variantDisplayName(v),
            rawName: (v.name || '').trim(),
            price: eff,
            quantity: typeof v.quantity === 'number' ? v.quantity : 0,
            sku: v.sku || null,
        };
    });
    const hasVariants = variants.length > 0;
    const baseEff = resolveProductPrice({
        salesActive,
        price: p.price,
        salePrice: p.sale_price,
        compareAtPrice: p.compare_at_price,
        discountPercent,
    }).effective;
    const displayPrice = hasVariants
        ? Math.min(...variants.map((v) => v.price), baseEff)
        : baseEff;
    const stockQty = hasVariants
        ? variants.reduce((sum, v) => sum + v.quantity, 0)
        : Number(p.quantity) || 0;

    return {
        id: p.id,
        name: p.name,
        price: displayPrice,
        quantity: stockQty,
        category: categoryNameFromRow(p.categories),
        image: p.product_images?.[0]?.url || 'https://via.placeholder.com/150',
        sku: p.sku || '',
        slug: p.slug || '',
        hasVariants,
        variants,
    };
}

export default function POSPage() {
    const [products, setProducts] = useState<Product[]>([]);
    const [categories, setCategories] = useState<string[]>([]);
    const [cart, setCart] = useState<CartItem[]>([]);
    const [activeCategory, setActiveCategory] = useState('All');
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<Product[] | null>(null);
    const [searchingRemote, setSearchingRemote] = useState(false);
    const [pricingState, setPricingState] = useState({ salesActive: false, discountPercent: 0 });
    const [loading, setLoading] = useState(true);
    const [isMobileCartOpen, setIsMobileCartOpen] = useState(false);
    const [variantPickerProduct, setVariantPickerProduct] = useState<Product | null>(null);

    // Checkout State
    const [showCheckoutModal, setShowCheckoutModal] = useState(false);
    const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
    const [customers, setCustomers] = useState<Customer[]>([]);
    const [customerSearch, setCustomerSearch] = useState('');
    const [paymentMethod, setPaymentMethod] = useState('cash');
    const [amountTendered, setAmountTendered] = useState<string>('');
    const [processing, setProcessing] = useState(false);
    const [completedOrder, setCompletedOrder] = useState<any>(null);
    const [checkoutError, setCheckoutError] = useState<string | null>(null);
    const [deliveryMethod, setDeliveryMethod] = useState<'pickup' | 'doorstep'>('pickup');
    const [guestDetails, setGuestDetails] = useState({
        firstName: '',
        lastName: '',
        email: '',
        phone: '',
        address: '',
        city: '',
        region: ''
    });
    const [savingCustomer, setSavingCustomer] = useState(false);
    const [customerSaved, setCustomerSaved] = useState(false);
    // Thermal paper width — 58mm (most common) or 80mm. Persisted to localStorage.
    const [paperWidth, setPaperWidth] = useState<'58' | '80'>('58');

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const saved = window.localStorage.getItem('pos.paperWidth');
        if (saved === '58' || saved === '80') setPaperWidth(saved);
    }, []);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        window.localStorage.setItem('pos.paperWidth', paperWidth);
    }, [paperWidth]);

    const ghanaRegions = [
        'Greater Accra', 'Ashanti', 'Western', 'Central', 'Eastern',
        'Northern', 'Volta', 'Upper East', 'Upper West', 'Brong-Ahafo',
        'Ahafo', 'Bono', 'Bono East', 'North East', 'Savannah', 'Oti', 'Western North'
    ];

    useEffect(() => {
        fetchData();
    }, []);

    const fetchData = async () => {
        try {
            setLoading(true);
            const { data: pricingRow } = await supabase
                .from('site_settings')
                .select('value')
                .eq('key', 'store_pricing')
                .maybeSingle();
            const { sales_active: salesActive, discount_percent: discountPercent } = parseStorePricingValue(pricingRow?.value);
            setPricingState({ salesActive, discountPercent });

            const { data: prodData } = await supabase
                .from('products')
                .select(`
          id, name, slug, price, sale_price, compare_at_price, quantity, sku,
          categories(name),
          product_images(url),
          product_variants(id, name, option1, option2, price, sale_price, quantity, sku)
        `)
                .eq('status', 'active')
                .order('name')
                .limit(1000);

            if (prodData) {
                const formatted: Product[] = prodData.map((p: any) => formatPosProduct(p, salesActive, discountPercent));
                setProducts(formatted);

                // Extract Categories
                const cats = Array.from(new Set(formatted.map(p => p.category))).sort();
                setCategories(['All', ...cats]);
            }

            // Fetch Customers from customers table (not profiles)
            const { data: custData } = await supabase
                .from('customers')
                .select('id, full_name, email, phone')
                .order('full_name')
                .limit(200);

            if (custData) setCustomers(custData);

        } catch (error) {
            console.error('Error fetching POS data:', error);
        } finally {
            setLoading(false);
        }
    };

    const lineKeyFor = (productId: string, variantId?: string | null) =>
        variantId ? `${productId}::v::${variantId}` : `${productId}::base`;

    const addToCart = (product: Product, selectedVariant?: PosVariant | null) => {
        if (product.hasVariants && !selectedVariant) {
            setVariantPickerProduct(product);
            return;
        }
        const v = selectedVariant ?? null;
        const key = lineKeyFor(product.id, v?.id ?? null);
        const linePrice = v ? v.price : product.price;
        setCart(prev => {
            const existing = prev.find(item => item.lineKey === key);
            if (existing) {
                return prev.map(item =>
                    item.lineKey === key
                        ? { ...item, cartQuantity: item.cartQuantity + 1 }
                        : item
                );
            }
            const line: CartItem = {
                ...product,
                price: linePrice,
                lineKey: key,
                cartQuantity: 1,
                variantId: v?.id ?? null,
                variant: v?.label ?? null,
                variantSku: v?.sku ?? null,
                variantDisplay: v?.displayName ?? null,
                variantRawName: v?.rawName ?? null,
            };
            return [...prev, line];
        });
    };

    const removeFromCart = (lineKey: string) => {
        setCart(prev => prev.filter(item => item.lineKey !== lineKey));
    };

    const updateQuantity = (lineKey: string, delta: number) => {
        setCart(prev =>
            prev.flatMap(item => {
                if (item.lineKey !== lineKey) return [item];
                const newQty = item.cartQuantity + delta;
                return newQty > 0 ? [{ ...item, cartQuantity: newQty }] : [];
            })
        );
    };

    const emptyCart = () => setCart([]);

    // Debounced server search (finds products beyond the initial 1000-row fetch)
    useEffect(() => {
        const q = searchQuery.trim().replace(/,/g, ' ');
        if (q.length < 2) {
            setSearchResults(null);
            setSearchingRemote(false);
            return;
        }
        const tick = setTimeout(async () => {
            setSearchingRemote(true);
            const { salesActive, discountPercent } = pricingState;
            const escaped = escapeIlike(q);
            const pattern = `%${escaped}%`;
            const sel = `
          id, name, slug, price, sale_price, compare_at_price, quantity, sku,
          categories(name),
          product_images(url),
          product_variants(id, name, option1, option2, price, sale_price, quantity, sku)
        `;
            try {
                const [byName, bySku, bySlug] = await Promise.all([
                    supabase.from('products').select(sel).eq('status', 'active').ilike('name', pattern).limit(250),
                    supabase.from('products').select(sel).eq('status', 'active').ilike('sku', pattern).limit(250),
                    supabase.from('products').select(sel).eq('status', 'active').ilike('slug', pattern).limit(250),
                ]);
                const map = new Map<string, Product>();
                for (const row of [...(byName.data || []), ...(bySku.data || []), ...(bySlug.data || [])]) {
                    map.set(row.id, formatPosProduct(row, salesActive, discountPercent));
                }
                const merged = Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
                setSearchResults(merged.slice(0, 400));
            } catch (e) {
                console.error('POS search error:', e);
                setSearchResults(null);
            } finally {
                setSearchingRemote(false);
            }
        }, 280);
        return () => clearTimeout(tick);
    }, [searchQuery, pricingState]);

    // Computed
    const filteredProducts = useMemo(() => {
        const q = searchQuery.toLowerCase().trim().replace(/,/g, ' ');
        const useRemote = searchResults !== null && q.length >= 2;
        const list = useRemote ? searchResults! : products;

        const matchesTokens = (p: Product) => {
            if (!q) return true;
            if (useRemote) return true;
            const variantText = (p.variants || [])
                .map(v => [v.label, v.displayName, v.sku || '', v.rawName].join(' '))
                .join(' ');
            const hay = `${p.name} ${p.sku || ''} ${p.slug || ''} ${variantText}`.toLowerCase();
            return q.split(/\s+/).filter(Boolean).every(t => t.length > 0 && hay.includes(t));
        };

        return list.filter(p => {
            const matchesCat =
                q.length > 0 || activeCategory === 'All' || p.category === activeCategory;
            return matchesTokens(p) && matchesCat;
        });
    }, [products, searchResults, searchQuery, activeCategory]);

    // Filter customers by search
    const filteredCustomers = useMemo(() => {
        if (!customerSearch.trim()) return customers;
        const q = customerSearch.toLowerCase();
        return customers.filter(c =>
            c.full_name?.toLowerCase().includes(q) ||
            c.email?.toLowerCase().includes(q) ||
            c.phone?.includes(q)
        );
    }, [customers, customerSearch]);

    const cartTotal = cart.reduce((sum, item) => sum + (item.price * item.cartQuantity), 0);
    const tax = cartTotal * 0.0;
    const grandTotal = cartTotal + tax;
    const changeDue = amountTendered ? (parseFloat(amountTendered) - grandTotal) : 0;

    // Get the customer email and phone for the order
    const getOrderEmail = () => {
        if (selectedCustomer) return selectedCustomer.email;
        return guestDetails.email || 'pos-walkin@store.local';
    };

    const getOrderPhone = () => {
        if (selectedCustomer) return selectedCustomer.phone || '';
        return guestDetails.phone || '';
    };

    const getCustomerFullName = () => {
        if (selectedCustomer) return selectedCustomer.full_name || '';
        return `${guestDetails.firstName} ${guestDetails.lastName}`.trim();
    };

    const handleSaveCustomer = async () => {
        const name = `${guestDetails.firstName} ${guestDetails.lastName}`.trim();
        if (!name && !guestDetails.phone) return;

        setSavingCustomer(true);
        setCustomerSaved(false);
        try {
            const email = guestDetails.email?.trim() ||
                (guestDetails.phone ? `${guestDetails.phone.replace(/[^0-9]/g, '')}@pos.local` : null);
            if (!email) { setSavingCustomer(false); return; }

            await supabase.rpc('upsert_customer_from_order', {
                p_email: email,
                p_phone: guestDetails.phone || null,
                p_full_name: name || null,
                p_first_name: guestDetails.firstName || null,
                p_last_name: guestDetails.lastName || null,
                p_user_id: null,
                p_address: null,
            });

            const { data: refreshed } = await supabase
                .from('customers')
                .select('id, full_name, email, phone')
                .order('full_name')
                .limit(200);

            if (refreshed) {
                setCustomers(refreshed);
                const saved = refreshed.find(c =>
                    c.phone === guestDetails.phone ||
                    c.email === email
                );
                if (saved) setSelectedCustomer(saved);
            }

            setCustomerSaved(true);
            setTimeout(() => setCustomerSaved(false), 3000);
        } catch (err) {
            console.error('Save customer error:', err);
        } finally {
            setSavingCustomer(false);
        }
    };

    // Validate before checkout
    const validateCheckout = (): string | null => {
        if (cart.length === 0) return 'Cart is empty';

        if (paymentMethod === 'momo') {
            const phone = getOrderPhone();
            if (!phone) return 'Phone number is required for Mobile Money payment';
        }

        if (paymentMethod === 'cash') {
            const tendered = parseFloat(amountTendered || '0');
            if (tendered < grandTotal) return 'Insufficient amount tendered';
        }

        // For guest, require at least a name or phone
        if (!selectedCustomer) {
            const hasName = guestDetails.firstName.trim() || guestDetails.lastName.trim();
            const hasContact = guestDetails.email.trim() || guestDetails.phone.trim();
            if (!hasName && !hasContact) return 'Please enter customer name or contact info';
        }

        // Require address for doorstep delivery
        if (deliveryMethod === 'doorstep') {
            if (!guestDetails.address.trim()) return 'Delivery address is required';
            if (!guestDetails.city.trim()) return 'City is required for delivery';
            if (!guestDetails.region) return 'Region is required for delivery';
        }

        return null;
    };

    // Checkout Logic
    const handleCheckout = async () => {
        const validationError = validateCheckout();
        if (validationError) {
            setCheckoutError(validationError);
            return;
        }

        setProcessing(true);
        setCheckoutError(null);

        try {
            const orderNumber = `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            const customerName = getCustomerFullName();
            const customerEmail = getOrderEmail();
            const customerPhone = getOrderPhone();

            const isCashOrCard = paymentMethod === 'cash' || paymentMethod === 'card';

            const cartIds = [...new Set(cart.map((i) => i.id))];
            const { data: checkoutPricingRow } = await supabase
                .from('site_settings')
                .select('value')
                .eq('key', 'store_pricing')
                .maybeSingle();
            const { sales_active: checkoutSalesActive, discount_percent: checkoutDiscountPercent } = parseStorePricingValue(
                checkoutPricingRow?.value
            );
            const { data: checkoutProducts, error: checkoutProductsError } =
                await supabase
                    .from('products')
                    .select(
                        'id, price, sale_price, compare_at_price, product_variants(id, name, option1, option2, price, sale_price)'
                    )
                    .in('id', cartIds);
            if (checkoutProductsError) throw checkoutProductsError;
            const checkoutProductMap = new Map(
                (checkoutProducts || []).map((p: any) => [p.id, p])
            );

            let posSubtotal = 0;
            const resolvedLines: { item: CartItem; unit: number }[] = [];
            for (const item of cart) {
                const p = checkoutProductMap.get(item.id);
                if (!p) throw new Error(`Product not found: ${item.name}`);
                const unit = resolveCartLineUnitPrice(
                    p,
                    item.variant,
                    checkoutSalesActive,
                    checkoutDiscountPercent
                );
                posSubtotal += unit * item.cartQuantity;
                resolvedLines.push({ item, unit });
            }
            const posTax = 0;
            const posGrand = posSubtotal + posTax;

            if (paymentMethod === 'cash') {
                const tendered = parseFloat(amountTendered || '0');
                if (tendered < posGrand) {
                    setCheckoutError('Insufficient amount tendered');
                    setProcessing(false);
                    return;
                }
            }

            // Build shipping/billing address
            const addressData = selectedCustomer ? {
                firstName: selectedCustomer.full_name?.split(' ')[0] || '',
                lastName: selectedCustomer.full_name?.split(' ').slice(1).join(' ') || '',
                email: selectedCustomer.email,
                phone: selectedCustomer.phone || '',
                address: guestDetails.address,
                city: guestDetails.city,
                region: guestDetails.region,
                pos_sale: true
            } : {
                firstName: guestDetails.firstName,
                lastName: guestDetails.lastName,
                email: guestDetails.email,
                phone: guestDetails.phone,
                address: guestDetails.address,
                city: guestDetails.city,
                region: guestDetails.region,
                pos_sale: true
            };

            // 1. Create Order
            const { data: order, error: orderError } = await supabase
                .from('orders')
                .insert([{
                    order_number: orderNumber,
                    user_id: null,
                    email: customerEmail,
                    phone: customerPhone,
                    status: isCashOrCard ? 'processing' : 'pending',
                    payment_status: isCashOrCard ? 'paid' : 'pending',
                    currency: 'GHS',
                    subtotal: posSubtotal,
                    tax_total: posTax,
                    shipping_total: 0,
                    discount_total: 0,
                    total: posGrand,
                    shipping_method: deliveryMethod,
                    payment_method: paymentMethod === 'momo' ? 'moolre' : paymentMethod,
                    shipping_address: addressData,
                    billing_address: addressData,
                    metadata: {
                        pos_sale: true,
                        first_name: addressData.firstName,
                        last_name: addressData.lastName,
                        phone: customerPhone
                    }
                }])
                .select()
                .single();

            if (orderError) throw orderError;

            // 2. Create Order Items (authoritative unit prices)
            const orderItems = resolvedLines.map(({ item, unit }) => ({
                order_id: order.id,
                product_id: item.id,
                variant_id: item.variantId || null,
                product_name: item.name,
                variant_name: item.variantRawName || null,
                sku: item.variantSku || item.sku || null,
                quantity: item.cartQuantity,
                unit_price: unit,
                total_price: unit * item.cartQuantity,
                metadata: {
                    image: item.image,
                    pos_sale: true,
                    variant_label: item.variant || null,
                    variant_display: item.variantDisplay || null,
                }
            }));

            const { error: itemsError } = await supabase
                .from('order_items')
                .insert(orderItems);

            if (itemsError) throw itemsError;

            // 3. Upsert Customer Record (email is required in customers table)
            const hasRealEmail = customerEmail && customerEmail !== 'pos-walkin@store.local';
            const upsertEmail = hasRealEmail
                ? customerEmail
                : customerPhone
                    ? `${customerPhone.replace(/[^0-9]/g, '')}@pos.local`
                    : null;

            if (upsertEmail) {
                try {
                    await supabase.rpc('upsert_customer_from_order', {
                        p_email: upsertEmail,
                        p_phone: customerPhone || null,
                        p_full_name: customerName || null,
                        p_first_name: addressData.firstName || null,
                        p_last_name: addressData.lastName || null,
                        p_user_id: null,
                        p_address: addressData
                    });
                    // Refresh customer list silently
                    supabase.from('customers').select('id, full_name, email, phone').order('full_name').limit(200)
                        .then(({ data }) => { if (data) setCustomers(data); });
                } catch (custErr) {
                    console.error('Customer upsert error (non-fatal):', custErr);
                }
            }

            // 4. If Cash or Card — mark as paid, reduce stock via server-side API
            //    (must use service_role key so the RPC's auth guard passes)
            if (isCashOrCard) {
                try {
                    const { data: { session: posSession } } = await supabase.auth.getSession();
                    const markRes = await fetch('/api/pos/mark-paid', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            ...(posSession?.access_token && { 'Authorization': `Bearer ${posSession.access_token}` }),
                        },
                        body: JSON.stringify({
                            order_ref: orderNumber,
                            moolre_ref: `POS-${paymentMethod.toUpperCase()}-${Date.now()}`
                        }),
                    });
                    if (!markRes.ok) {
                        const errBody = await markRes.json().catch(() => ({}));
                        console.error('Stock reduction API error:', errBody);
                    }
                } catch (stockErr) {
                    console.error('Stock reduction error (non-fatal):', stockErr);
                }

                // Success — show completed
                setCompletedOrder({ id: order.id, orderNumber, total: posGrand, items: cart });
                setCart([]);

                // Confirmations (email + SMS): notify when we have a real phone or a non–walk-in email.
                // Previously we skipped entirely for walk-in placeholder email, which blocked SMS even when phone was present.
                const phoneForNotify = (getOrderPhone() || '').trim();
                const shouldNotify =
                    phoneForNotify.length > 0 ||
                    (Boolean(customerEmail) && customerEmail !== 'pos-walkin@store.local');
                if (shouldNotify) {
                    const { data: { session } } = await supabase.auth.getSession();
                    fetch('/api/notifications', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            ...(session?.access_token && { 'Authorization': `Bearer ${session.access_token}` })
                        },
                        body: JSON.stringify({
                            type: 'order_created',
                            payload: {
                                ...order,
                                order_number: orderNumber,
                                email: customerEmail,
                                phone: phoneForNotify || order.phone,
                                shipping_address: addressData
                            }
                        })
                    }).catch(err => console.error('POS Notification error:', err));
                }
            }

            // 5. If Momo — initiate Moolre payment
            if (paymentMethod === 'momo') {
                const paymentRes = await fetch('/api/payment/moolre', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        orderId: orderNumber,
                        amount: posGrand,
                        customerEmail: customerEmail
                    })
                });

                const paymentResult = await paymentRes.json();

                if (!paymentResult.success) {
                    throw new Error(paymentResult.message || 'Failed to initiate Mobile Money payment');
                }

                // Show completed with payment link
                setCompletedOrder({
                    id: order.id,
                    orderNumber,
                    total: posGrand,
                    items: cart,
                    paymentUrl: paymentResult.url,
                    paymentPending: true
                });
                setCart([]);
            }

        } catch (error: any) {
            console.error('Checkout failed:', error);
            setCheckoutError(error.message || 'Checkout failed. Please try again.');
        } finally {
            setProcessing(false);
        }
    };

    const handlePrintReceipt = () => {
        if (!completedOrder) return;
        const items = completedOrder.items || [];

        // ---------------------------------------------------------------
        // Thermal printer geometry
        // ---------------------------------------------------------------
        // 58mm paper roll → ~48mm printable area (≈384 dots @ 203 DPI)
        // 80mm paper roll → ~72mm printable area (≈576 dots @ 203 DPI)
        // We keep 5mm margin on each side of 58mm and 4mm on 80mm to allow
        // for paper-feed drift and the head's non-printable strip. The
        // content body width is intentionally smaller than the paper width
        // so right-aligned values (TOTAL, prices) cannot be clipped.
        // ---------------------------------------------------------------
        const is80 = paperWidth === '80';
        const pageSize = is80 ? '80mm auto' : '58mm auto';
        const sideMargin = is80 ? '4mm' : '5mm';
        const bodyWidth = is80 ? '72mm' : '48mm';
        // Column widths for the items table (must sum to bodyWidth)
        const nameColW = is80 ? '40mm' : '24mm';
        const qtyColW = is80 ? '8mm' : '6mm';
        const priceColW = is80 ? '24mm' : '18mm';

        const escapeHtml = (s: string) =>
            String(s ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');

        const itemRows = items.map((i: any) => {
            const variantBit = i.variantDisplay ? ` ${i.variantDisplay}` : '';
            const name = escapeHtml(`${i.name}${variantBit}`);
            const qty = i.cartQuantity;
            const amt = (i.price * i.cartQuantity).toFixed(2);
            return `<tr>
                <td class="name">${name}</td>
                <td class="qty">${qty}</td>
                <td class="amt">${amt}</td>
            </tr>`;
        }).join('');

        const cashRows = (paymentMethod === 'cash' && changeDue > 0) ? `
            <tr><td class="lbl">Tendered</td><td class="val">GH${'\u20B5'}${parseFloat(amountTendered).toFixed(2)}</td></tr>
            <tr class="bold"><td class="lbl">Change</td><td class="val">GH${'\u20B5'}${changeDue.toFixed(2)}</td></tr>
        ` : '';

        const receiptHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Receipt #${escapeHtml(completedOrder.orderNumber)}</title>
<style>
    /* =====================================================
       Thermal-printer-safe stylesheet
       - Pure black/white, no gradients/shadows/transforms
       - Monospaced font (consistent character cells)
       - Table layout with fixed mm column widths
       - All sizing in mm/pt (NOT px) for accurate paper fit
       ===================================================== */
    @page {
        size: ${pageSize};
        margin: 3mm ${sideMargin};
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    html, body {
        background: #fff;
        color: #000;
    }

    body {
        font-family: 'Courier New', Courier, 'Liberation Mono', monospace;
        font-size: 10pt;
        line-height: 1.25;
        width: ${bodyWidth};
        max-width: ${bodyWidth};
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
    }

    .center { text-align: center; }
    .bold   { font-weight: 700; }
    .small  { font-size: 8pt; }

    /* Dashed rule. Use solid 1px black for printers that drop dashed
       patterns at low DPI. */
    hr.sep {
        border: 0;
        border-top: 1px dashed #000;
        margin: 1.5mm 0;
    }

    /* Store header */
    .store-name {
        font-size: 13pt;
        font-weight: 700;
        letter-spacing: 0.3pt;
    }
    .store-meta { font-size: 8pt; }

    /* All rows use table layout — flex is unreliable on thermal drivers */
    table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
    }
    table.meta td { padding: 0.3mm 0; vertical-align: top; }
    table.meta td.k { width: ${is80 ? '20mm' : '14mm'}; font-weight: 700; }
    table.meta td.v { text-align: right; overflow-wrap: break-word; word-break: break-word; }

    table.items {
        margin-top: 0.5mm;
    }
    table.items th,
    table.items td {
        padding: 0.4mm 0;
        vertical-align: top;
        font-size: 9pt;
    }
    table.items th {
        font-weight: 700;
        text-align: left;
        border-bottom: 1px solid #000;
    }
    table.items td.name {
        width: ${nameColW};
        overflow-wrap: break-word;
        word-break: break-word;
    }
    table.items td.qty,
    table.items th.qty {
        width: ${qtyColW};
        text-align: center;
    }
    table.items td.amt,
    table.items th.amt {
        width: ${priceColW};
        text-align: right;
        font-variant-numeric: tabular-nums;
    }

    /* Totals table — gives the price column a dedicated, generous
       fixed width so the TOTAL value can never be clipped. */
    table.totals {
        margin-top: 0.5mm;
    }
    table.totals td.lbl {
        width: ${is80 ? '40mm' : '22mm'};
        font-weight: 700;
        padding: 0.6mm 0;
    }
    table.totals td.val {
        text-align: right;
        font-variant-numeric: tabular-nums;
        padding: 0.6mm 0;
    }
    table.totals tr.grand td {
        font-size: 13pt;
        font-weight: 700;
        padding: 1mm 0;
        border-top: 1px solid #000;
        border-bottom: 1px solid #000;
    }

    .footer {
        margin-top: 2mm;
        text-align: center;
    }
    .footer p { line-height: 1.3; }

    /* Anything we never want to show in print (just in case) */
    .no-print { display: none !important; }
</style>
</head>
<body>
    <div class="center">
        <p class="store-name">Maries Hair</p>
        <p class="store-meta">Kpakpo mankralo road 55</p>
        <p class="store-meta">Mataheko &middot; 0547742920</p>
    </div>

    <hr class="sep" />

    <table class="meta">
        <tr><td class="k">Order</td><td class="v">#${escapeHtml(completedOrder.orderNumber)}</td></tr>
        <tr><td class="k">Date</td><td class="v">${escapeHtml(new Date().toLocaleString())}</td></tr>
        <tr><td class="k">Pay</td><td class="v">${escapeHtml(paymentMethod.toUpperCase())}</td></tr>
    </table>

    <hr class="sep" />

    <table class="items">
        <thead>
            <tr>
                <th class="name">Item</th>
                <th class="qty">Qty</th>
                <th class="amt">Amt</th>
            </tr>
        </thead>
        <tbody>
            ${itemRows}
        </tbody>
    </table>

    <hr class="sep" />

    <table class="totals">
        <tr class="grand">
            <td class="lbl">TOTAL</td>
            <td class="val">GH${'\u20B5'}${completedOrder.total.toFixed(2)}</td>
        </tr>
        ${cashRows}
    </table>

    <hr class="sep" />

    <div class="footer">
        <p>Thank you for shopping!</p>
        <p class="small">www.shopmarieshair.com</p>
    </div>
</body>
</html>`;

        // Use an off-screen iframe rather than window.open() — pop-up
        // blockers and small popup windows can race with print(), causing
        // the page to render before layout has settled (= clipped text).
        const iframe = document.createElement('iframe');
        iframe.setAttribute('aria-hidden', 'true');
        iframe.style.position = 'fixed';
        iframe.style.right = '0';
        iframe.style.bottom = '0';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.border = '0';
        iframe.style.visibility = 'hidden';
        document.body.appendChild(iframe);

        const cleanup = () => {
            // Defer removal so the print dialog has time to fire.
            setTimeout(() => {
                try { document.body.removeChild(iframe); } catch { /* already gone */ }
            }, 1000);
        };

        const doPrint = () => {
            const win = iframe.contentWindow;
            if (!win) { cleanup(); return; }
            try {
                win.focus();
                win.print();
            } catch (e) {
                console.error('[POS] Print failed:', e);
            }
            cleanup();
        };

        iframe.onload = () => {
            const win = iframe.contentWindow;
            if (!win) { cleanup(); return; }
            // Wait for fonts so Courier rasterises before printing — without
            // this, the printer sometimes captures a partially-loaded layout
            // and the rightmost column gets shifted/clipped.
            const fonts = (win.document as any).fonts;
            const ready = fonts && typeof fonts.ready?.then === 'function'
                ? fonts.ready
                : Promise.resolve();
            ready.then(() => {
                // Small extra tick lets the layout engine finalise widths.
                setTimeout(doPrint, 100);
            }).catch(() => setTimeout(doPrint, 100));
        };

        // Write the HTML into the iframe.
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!doc) { cleanup(); return; }
        doc.open();
        doc.write(receiptHtml);
        doc.close();
    };

    const resetCheckout = () => {
        setShowCheckoutModal(false);
        setCompletedOrder(null);
        setAmountTendered('');
        setSelectedCustomer(null);
        setCustomerSearch('');
        setCheckoutError(null);
        setPaymentMethod('cash');
        setDeliveryMethod('pickup');
        setSavingCustomer(false);
        setCustomerSaved(false);
        setGuestDetails({
            firstName: '',
            lastName: '',
            email: '',
            phone: '',
            address: '',
            city: '',
            region: ''
        });
    };

    return (
        <div className="flex flex-col lg:flex-row h-[calc(100vh-90px)] -m-4 lg:-m-6 overflow-hidden bg-gray-100 relative">

            {/* LEFT: Product Grid */}
            <div className={`flex-1 flex flex-col h-full min-w-0 ${isMobileCartOpen ? 'hidden lg:flex' : 'flex'}`}>
                {/* Header / Search */}
                <div className="bg-white p-4 border-b border-gray-200 flex items-center justify-between space-x-4 shrink-0">
                    <form
                        className="relative flex-1 max-w-lg"
                        onSubmit={(e) => e.preventDefault()}
                    >
                        <i className="ri-search-line absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"></i>
                        <input
                            type="search"
                            enterKeyHint="search"
                            placeholder="Search name, SKU, or slug…"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full pl-10 pr-10 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-stone-500 text-sm"
                            autoComplete="off"
                            autoFocus
                        />
                        {searchingRemote && (
                            <span className="absolute right-3 top-1/2 -translate-y-1/2">
                                <i className="ri-loader-4-line animate-spin text-stone-600 text-lg"></i>
                            </span>
                        )}
                        {!searchingRemote && searchQuery.trim().length > 0 && (
                            <button
                                type="button"
                                onClick={() => { setSearchQuery(''); setSearchResults(null); }}
                                className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                                aria-label="Clear search"
                            >
                                <i className="ri-close-line text-lg"></i>
                            </button>
                        )}
                    </form>
                    <div className="flex items-center space-x-2 overflow-x-auto no-scrollbar">
                        {categories.map(cat => (
                            <button
                                key={cat}
                                onClick={() => setActiveCategory(cat)}
                                className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${activeCategory === cat
                                    ? 'bg-stone-700 text-white shadow-md'
                                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                    }`}
                            >
                                {cat}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Grid Area */}
                <div className="flex-1 overflow-y-auto p-4 content-start">
                    {loading ? (
                        <div className="flex items-center justify-center h-full text-gray-500">Loading products...</div>
                    ) : filteredProducts.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-gray-500">
                            <i className="ri-inbox-line text-4xl mb-2"></i>
                            <p>No products found</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 pb-20 lg:pb-4">
                            {filteredProducts.map(product => (
                                <div
                                    key={product.id}
                                    onClick={() => addToCart(product)}
                                    className="bg-white rounded-xl shadow-sm hover:shadow-md transition-shadow cursor-pointer overflow-hidden border border-gray-100 group flex flex-col h-full"
                                >
                                    <div className="aspect-square relative bg-gray-50 shrink-0">
                                        <img
                                            src={product.image}
                                            alt={product.name}
                                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                                        />
                                        <div className="absolute top-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded-full backdrop-blur-sm">
                                            {product.hasVariants ? `${product.variants.length} opts` : `Qty: ${product.quantity}`}
                                        </div>
                                    </div>
                                    <div className="p-3 flex flex-col flex-1">
                                        <h3 className="text-sm font-semibold text-gray-900 line-clamp-2 mb-auto">{product.name}</h3>
                                        {product.hasVariants && (
                                            <p className="text-[11px] text-stone-600 mt-1 line-clamp-2">
                                                {product.variants.slice(0, 3).map(v => v.displayName).join(' · ')}
                                                {product.variants.length > 3 ? '…' : ''}
                                            </p>
                                        )}
                                        <div className="flex items-center justify-between mt-2 pt-2">
                                            <div className="min-w-0">
                                                <span className="text-stone-700 font-bold">
                                                    {product.hasVariants ? 'From ' : ''}GH₵{product.price.toFixed(2)}
                                                </span>
                                                {product.hasVariants && (
                                                    <span className="block text-[10px] text-gray-500">Tap to choose option</span>
                                                )}
                                            </div>
                                            <button
                                                type="button"
                                                onClick={(e) => { e.stopPropagation(); addToCart(product); }}
                                                className="w-8 h-8 rounded-full bg-stone-50 text-stone-700 flex items-center justify-center group-hover:bg-stone-700 group-hover:text-white transition-colors shrink-0"
                                                aria-label={product.hasVariants ? 'Choose variant' : 'Add to cart'}
                                            >
                                                <i className="ri-add-line"></i>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Mobile Bottom Cart Bar */}
                {cart.length > 0 && (
                    <div className="lg:hidden p-4 border-t border-gray-200 bg-white fixed bottom-0 left-0 right-0 z-30 shadow-2xl safe-area-bottom">
                        <button
                            onClick={() => setIsMobileCartOpen(true)}
                            className="w-full py-3 bg-stone-700 text-white rounded-xl font-bold flex justify-between px-6 shadow-lg active:scale-95 transition-transform"
                        >
                            <span className="flex items-center text-sm">
                                <span className="bg-white/20 px-2 py-0.5 rounded mr-2">{cart.reduce((a, b) => a + b.cartQuantity, 0)}</span>
                                Items
                            </span>
                            <span>View Cart</span>
                            <span>GH₵{grandTotal.toFixed(2)}</span>
                        </button>
                    </div>
                )}
            </div>

            {/* RIGHT: Cart Panel */}
            <div className={`w-full lg:w-96 bg-white border-l border-gray-200 flex flex-col h-full shadow-lg z-20 absolute inset-0 lg:relative ${isMobileCartOpen ? 'flex' : 'hidden lg:flex'}`}>
                <div className="p-4 border-b border-gray-200 flex items-center justify-between bg-gray-50 shrink-0">
                    <div className="flex items-center">
                        <button onClick={() => setIsMobileCartOpen(false)} className="lg:hidden mr-3 p-2 -ml-2 text-gray-600 hover:bg-gray-200 rounded-full transition-colors">
                            <i className="ri-arrow-left-line text-xl"></i>
                        </button>
                        <h2 className="text-lg font-bold text-gray-900 flex items-center">
                            <i className="ri-shopping-basket-2-line mr-2"></i>
                            Current Order
                        </h2>
                    </div>
                    <span className="bg-stone-100 text-stone-800 text-xs font-bold px-2 py-1 rounded-full">
                        {cart.reduce((a, b) => a + b.cartQuantity, 0)} Items
                    </span>
                </div>

                {/* Cart Items */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {cart.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-gray-400 space-y-4">
                            <i className="ri-shopping-cart-line text-5xl opacity-20"></i>
                            <p className="text-sm">Cart is empty</p>
                            <button onClick={() => setIsMobileCartOpen(false)} className="lg:hidden text-stone-600 font-medium hover:underline">
                                Start Adding Products
                            </button>
                        </div>
                    ) : (
                        cart.map(item => (
                            <div key={item.lineKey} className="flex gap-3 p-3 bg-gray-50 rounded-lg group hover:bg-gray-100 transition-colors">
                                <div className="w-16 h-16 bg-white rounded-md overflow-hidden flex-shrink-0 border border-gray-200">
                                    <img src={item.image} className="w-full h-full object-cover" alt="" />
                                </div>
                                <div className="flex-1 min-w-0 flex flex-col justify-between">
                                    <div className="flex justify-between items-start gap-2">
                                        <div className="min-w-0">
                                            <p className="text-sm font-semibold text-gray-900 line-clamp-2">{item.name}</p>
                                            {item.variantDisplay && (
                                                <p className="text-xs text-stone-600 mt-0.5 line-clamp-2">{item.variantDisplay}</p>
                                            )}
                                        </div>
                                        <button type="button" onClick={() => removeFromCart(item.lineKey)} className="text-gray-400 hover:text-red-500 shrink-0">
                                            <i className="ri-delete-bin-line"></i>
                                        </button>
                                    </div>
                                    <div className="flex items-center justify-between mt-2">
                                        <div className="flex items-center space-x-2 bg-white rounded border border-gray-200 px-1 py-0.5">
                                            <button type="button" onClick={() => updateQuantity(item.lineKey, -1)} className="w-6 h-6 flex items-center justify-center text-gray-500 hover:bg-gray-100 rounded">
                                                <i className="ri-subtract-line text-xs"></i>
                                            </button>
                                            <span className="text-sm font-semibold w-6 text-center">{item.cartQuantity}</span>
                                            <button type="button" onClick={() => updateQuantity(item.lineKey, 1)} className="w-6 h-6 flex items-center justify-center text-gray-500 hover:bg-gray-100 rounded">
                                                <i className="ri-add-line text-xs"></i>
                                            </button>
                                        </div>
                                        <p className="text-sm font-bold text-gray-900">GH₵{(item.price * item.cartQuantity).toFixed(2)}</p>
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* Cart Footer */}
                <div className="p-4 bg-gray-50 border-t border-gray-200 space-y-4 shrink-0 safe-area-bottom">
                    <div className="space-y-1 text-sm">
                        <div className="flex justify-between text-gray-600">
                            <span>Subtotal</span>
                            <span>GH₵{cartTotal.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between text-gray-600">
                            <span>Tax (0%)</span>
                            <span>GH₵0.00</span>
                        </div>
                        <div className="flex justify-between text-xl font-bold text-gray-900 pt-2 border-t border-gray-200 mt-2">
                            <span>Total</span>
                            <span>GH₵{grandTotal.toFixed(2)}</span>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <button
                            onClick={emptyCart}
                            disabled={cart.length === 0}
                            className="px-4 py-3 border border-red-200 text-red-600 rounded-lg hover:bg-red-50 font-semibold text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Clear
                        </button>
                        <button
                            onClick={() => { setShowCheckoutModal(true); setCheckoutError(null); }}
                            disabled={cart.length === 0}
                            className="px-4 py-3 bg-stone-600 text-white rounded-lg hover:bg-stone-700 font-bold text-sm shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Charge GH₵{grandTotal.toFixed(2)}
                        </button>
                    </div>
                </div>
            </div>

            {/* Checkout Modal */}
            {showCheckoutModal && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
                        {completedOrder ? (
                            // SUCCESS STATE
                            <div className="p-8 text-center flex flex-col items-center justify-center space-y-6 overflow-y-auto">
                                <div className={`w-20 h-20 rounded-full flex items-center justify-center ${completedOrder.paymentPending ? 'bg-amber-100' : 'bg-stone-100'}`}>
                                    <i className={`text-5xl ${completedOrder.paymentPending ? 'ri-time-line text-amber-600' : 'ri-checkbox-circle-fill text-stone-600'}`}></i>
                                </div>
                                <div>
                                    <h2 className="text-2xl font-bold text-gray-900">
                                        {completedOrder.paymentPending ? 'Payment Link Generated!' : 'Payment Successful!'}
                                    </h2>
                                    <p className="text-gray-500 mt-1">Order #{completedOrder.orderNumber}</p>

                                    {!completedOrder.paymentPending && paymentMethod === 'cash' && changeDue > 0 && (
                                        <div className="mt-3 bg-stone-50 border border-stone-200 rounded-lg p-3">
                                            <p className="text-sm text-stone-700">Change Due</p>
                                            <p className="text-2xl font-bold text-stone-800">GH₵{changeDue.toFixed(2)}</p>
                                        </div>
                                    )}

                                    {completedOrder.paymentPending && completedOrder.paymentUrl && (
                                        <div className="mt-4 space-y-3">
                                            <p className="text-sm text-gray-600">
                                                Customer can pay using this link:
                                            </p>
                                            <a
                                                href={completedOrder.paymentUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex items-center px-6 py-3 bg-amber-600 text-white rounded-xl font-semibold hover:bg-amber-700 transition-colors"
                                            >
                                                <i className="ri-external-link-line mr-2"></i>
                                                Open Payment Page
                                            </a>
                                            <div className="mt-2">
                                                <button
                                                    onClick={() => {
                                                        navigator.clipboard.writeText(completedOrder.paymentUrl);
                                                        alert('Payment link copied!');
                                                    }}
                                                    className="text-sm text-stone-700 hover:text-stone-800 font-medium underline"
                                                >
                                                    <i className="ri-file-copy-line mr-1"></i>
                                                    Copy Link
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div className="w-full mt-4 space-y-3">
                                    <div className="flex items-center justify-center gap-2 text-sm">
                                        <span className="text-gray-600">Paper:</span>
                                        <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
                                            <button
                                                type="button"
                                                onClick={() => setPaperWidth('58')}
                                                className={`px-3 py-1.5 font-semibold transition-colors ${paperWidth === '58' ? 'bg-stone-700 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
                                            >
                                                58 mm
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setPaperWidth('80')}
                                                className={`px-3 py-1.5 font-semibold transition-colors border-l border-gray-300 ${paperWidth === '80' ? 'bg-stone-700 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
                                            >
                                                80 mm
                                            </button>
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-2 gap-4 w-full">
                                        <button onClick={handlePrintReceipt} className="py-3 px-4 border border-gray-300 rounded-xl font-semibold hover:bg-gray-50 transition-colors">
                                            <i className="ri-printer-line mr-2"></i>
                                            Print Receipt
                                        </button>
                                        <button onClick={resetCheckout} className="py-3 px-4 bg-stone-600 text-white rounded-xl font-semibold hover:bg-stone-700 transition-colors">
                                            New Order
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            // CHECKOUT FORM
                            <>
                                <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50 shrink-0">
                                    <h3 className="text-xl font-bold text-gray-900">Finalize Payment</h3>
                                    <button onClick={() => setShowCheckoutModal(false)} className="w-8 h-8 rounded-full hover:bg-gray-200 flex items-center justify-center text-gray-500">
                                        <i className="ri-close-line text-xl"></i>
                                    </button>
                                </div>

                                <div className="p-6 space-y-6 overflow-y-auto">
                                    {/* Error Display */}
                                    {checkoutError && (
                                        <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start space-x-2">
                                            <i className="ri-error-warning-line text-red-500 mt-0.5"></i>
                                            <p className="text-sm text-red-700">{checkoutError}</p>
                                        </div>
                                    )}

                                    {/* Total Display */}
                                    <div className="text-center py-4 bg-stone-50 rounded-xl border border-stone-100">
                                        <p className="text-sm text-stone-800 uppercase tracking-wide font-semibold">Amount to Pay</p>
                                        <p className="text-4xl font-extrabold text-stone-700 mt-1">GH₵{grandTotal.toFixed(2)}</p>
                                    </div>

                                    {/* Customer Select */}
                                    <div>
                                        <label className="block text-sm font-semibold text-gray-700 mb-2">Customer</label>

                                        {/* Customer search input */}
                                        <div className="relative mb-2">
                                            <i className="ri-search-line absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm"></i>
                                            <input
                                                type="text"
                                                placeholder="Search customers by name, email, or phone..."
                                                value={customerSearch}
                                                onChange={(e) => setCustomerSearch(e.target.value)}
                                                className="w-full pl-9 pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-stone-500 outline-none text-sm"
                                            />
                                        </div>

                                        <select
                                            className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-stone-500 outline-none mb-2"
                                            onChange={(e) => {
                                                setSelectedCustomer(customers.find(c => c.id === e.target.value) || null);
                                            }}
                                            value={selectedCustomer?.id || ''}
                                        >
                                            <option value="">Walk-in Customer / New Guest</option>
                                            {filteredCustomers.map(c => (
                                                <option key={c.id} value={c.id}>
                                                    {c.full_name || 'No Name'} — {c.phone || c.email}
                                                </option>
                                            ))}
                                        </select>

                                        {selectedCustomer && (
                                            <div className="bg-stone-50 border border-stone-200 rounded-lg p-3 mb-2 flex items-center justify-between">
                                                <div>
                                                    <p className="font-semibold text-gray-900 text-sm">{selectedCustomer.full_name}</p>
                                                    <p className="text-xs text-gray-600">{selectedCustomer.email} {selectedCustomer.phone && `| ${selectedCustomer.phone}`}</p>
                                                </div>
                                                <button
                                                    onClick={() => setSelectedCustomer(null)}
                                                    className="text-gray-400 hover:text-red-500 text-sm"
                                                >
                                                    <i className="ri-close-line"></i>
                                                </button>
                                            </div>
                                        )}

                                        {!selectedCustomer && (
                                            <div className="bg-gray-50 p-4 rounded-lg border border-gray-200 mt-2 space-y-3">
                                                <h4 className="text-sm font-bold text-gray-900 border-b border-gray-200 pb-2 mb-2">
                                                    New Customer Details
                                                </h4>
                                                <div className="grid grid-cols-2 gap-3">
                                                    <input
                                                        type="text"
                                                        placeholder="First Name *"
                                                        value={guestDetails.firstName}
                                                        onChange={e => setGuestDetails({ ...guestDetails, firstName: e.target.value })}
                                                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-stone-500 text-sm"
                                                    />
                                                    <input
                                                        type="text"
                                                        placeholder="Last Name"
                                                        value={guestDetails.lastName}
                                                        onChange={e => setGuestDetails({ ...guestDetails, lastName: e.target.value })}
                                                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-stone-500 text-sm"
                                                    />
                                                </div>
                                                <div className="grid grid-cols-2 gap-3">
                                                    <input
                                                        type="email"
                                                        placeholder="Email"
                                                        value={guestDetails.email}
                                                        onChange={e => setGuestDetails({ ...guestDetails, email: e.target.value })}
                                                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-stone-500 text-sm"
                                                    />
                                                    <input
                                                        type="tel"
                                                        placeholder={paymentMethod === 'momo' ? 'Phone (Required) *' : 'Phone'}
                                                        value={guestDetails.phone}
                                                        onChange={e => setGuestDetails({ ...guestDetails, phone: e.target.value })}
                                                        className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-1 focus:ring-stone-500 text-sm ${paymentMethod === 'momo' && !guestDetails.phone ? 'border-amber-400 bg-amber-50' : 'border-gray-300'
                                                            }`}
                                                    />
                                                </div>
                                                {(guestDetails.firstName.trim() || guestDetails.phone.trim()) && (
                                                    <button
                                                        type="button"
                                                        onClick={handleSaveCustomer}
                                                        disabled={savingCustomer}
                                                        className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-stone-700 hover:bg-stone-800 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                                                    >
                                                        {savingCustomer ? (
                                                            <>
                                                                <i className="ri-loader-4-line animate-spin"></i>
                                                                Saving...
                                                            </>
                                                        ) : customerSaved ? (
                                                            <>
                                                                <i className="ri-check-line text-green-300"></i>
                                                                Customer Saved!
                                                            </>
                                                        ) : (
                                                            <>
                                                                <i className="ri-save-line"></i>
                                                                Save Customer
                                                            </>
                                                        )}
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </div>

                                    {/* Delivery Method */}
                                    <div>
                                        <label className="block text-sm font-semibold text-gray-700 mb-2">Delivery Method</label>
                                        <div className="grid grid-cols-2 gap-3">
                                            <button
                                                onClick={() => setDeliveryMethod('pickup')}
                                                className={`p-3 rounded-lg border transition-all flex items-center space-x-3 ${deliveryMethod === 'pickup'
                                                    ? 'border-stone-600 bg-stone-50 ring-1 ring-stone-600'
                                                    : 'border-gray-200 hover:border-gray-300'
                                                    }`}
                                            >
                                                <i className={`ri-store-2-line text-xl ${deliveryMethod === 'pickup' ? 'text-stone-700' : 'text-gray-400'}`}></i>
                                                <div className="text-left">
                                                    <p className={`text-sm font-semibold ${deliveryMethod === 'pickup' ? 'text-stone-800' : 'text-gray-700'}`}>Store Pickup</p>
                                                    <p className="text-xs text-gray-500">Customer picks up</p>
                                                </div>
                                            </button>
                                            <button
                                                onClick={() => setDeliveryMethod('doorstep')}
                                                className={`p-3 rounded-lg border transition-all flex items-center space-x-3 ${deliveryMethod === 'doorstep'
                                                    ? 'border-stone-600 bg-stone-50 ring-1 ring-stone-600'
                                                    : 'border-gray-200 hover:border-gray-300'
                                                    }`}
                                            >
                                                <i className={`ri-truck-line text-xl ${deliveryMethod === 'doorstep' ? 'text-stone-700' : 'text-gray-400'}`}></i>
                                                <div className="text-left">
                                                    <p className={`text-sm font-semibold ${deliveryMethod === 'doorstep' ? 'text-stone-800' : 'text-gray-700'}`}>Doorstep Delivery</p>
                                                    <p className="text-xs text-gray-500">Deliver to address</p>
                                                </div>
                                            </button>
                                        </div>

                                        {/* Delivery Address (shown for doorstep delivery) */}
                                        {deliveryMethod === 'doorstep' && (
                                            <div className="mt-3 bg-stone-50 p-4 rounded-lg border border-stone-200 space-y-3">
                                                <h4 className="text-sm font-bold text-gray-900 flex items-center">
                                                    <i className="ri-map-pin-line mr-2 text-stone-600"></i>
                                                    Delivery Address
                                                </h4>
                                                <input
                                                    type="text"
                                                    placeholder="Street Address / Location *"
                                                    value={guestDetails.address}
                                                    onChange={e => setGuestDetails({ ...guestDetails, address: e.target.value })}
                                                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-stone-500 text-sm"
                                                />
                                                <div className="grid grid-cols-2 gap-3">
                                                    <input
                                                        type="text"
                                                        placeholder="City / Town *"
                                                        value={guestDetails.city}
                                                        onChange={e => setGuestDetails({ ...guestDetails, city: e.target.value })}
                                                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-stone-500 text-sm"
                                                    />
                                                    <select
                                                        value={guestDetails.region}
                                                        onChange={e => setGuestDetails({ ...guestDetails, region: e.target.value })}
                                                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-stone-500 text-sm"
                                                    >
                                                        <option value="">Select Region *</option>
                                                        {ghanaRegions.map(r => (
                                                            <option key={r} value={r}>{r}</option>
                                                        ))}
                                                    </select>
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    {/* Payment Method */}
                                    <div>
                                        <label className="block text-sm font-semibold text-gray-700 mb-2">Payment Method</label>
                                        <div className="grid grid-cols-3 gap-3">
                                            {[
                                                { key: 'cash', label: 'Cash', icon: 'ri-money-cny-circle-line' },
                                                { key: 'card', label: 'Card', icon: 'ri-bank-card-line' },
                                                { key: 'momo', label: 'MoMo', icon: 'ri-smartphone-line' }
                                            ].map(method => (
                                                <button
                                                    key={method.key}
                                                    onClick={() => setPaymentMethod(method.key)}
                                                    className={`py-3 rounded-lg font-medium border transition-all flex flex-col items-center space-y-1 ${paymentMethod === method.key
                                                        ? 'border-stone-600 bg-stone-50 text-stone-800 ring-1 ring-stone-600'
                                                        : 'border-gray-200 hover:border-gray-300 text-gray-600'
                                                        }`}
                                                >
                                                    <i className={`${method.icon} text-xl`}></i>
                                                    <span className="text-sm">{method.label}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Cash Tendered */}
                                    {paymentMethod === 'cash' && (
                                        <div>
                                            <label className="block text-sm font-semibold text-gray-700 mb-2">Amount Tendered</label>
                                            <div className="relative">
                                                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 font-bold">GH₵</span>
                                                <input
                                                    type="number"
                                                    value={amountTendered}
                                                    onChange={(e) => setAmountTendered(e.target.value)}
                                                    className="w-full pl-12 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-stone-500 outline-none font-bold text-lg"
                                                    placeholder="0.00"
                                                    autoFocus
                                                />
                                            </div>
                                            {changeDue > 0 && (
                                                <p className="text-right text-stone-600 font-bold mt-2">Change: GH₵{changeDue.toFixed(2)}</p>
                                            )}
                                            {changeDue < 0 && amountTendered && (
                                                <p className="text-right text-red-500 font-medium mt-2">Insufficient amount</p>
                                            )}
                                            {/* Quick amount buttons */}
                                            <div className="flex flex-wrap gap-2 mt-3">
                                                {[grandTotal, Math.ceil(grandTotal / 10) * 10, Math.ceil(grandTotal / 50) * 50, Math.ceil(grandTotal / 100) * 100].filter((v, i, a) => a.indexOf(v) === i).map(amount => (
                                                    <button
                                                        key={amount}
                                                        onClick={() => setAmountTendered(amount.toString())}
                                                        className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium text-gray-700 transition-colors"
                                                    >
                                                        GH₵{amount.toFixed(2)}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* MoMo info */}
                                    {paymentMethod === 'momo' && (
                                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                                            <div className="flex items-start space-x-2">
                                                <i className="ri-information-line text-amber-600 mt-0.5"></i>
                                                <div className="text-sm text-amber-800">
                                                    <p className="font-semibold">Mobile Money Payment</p>
                                                    <p className="mt-1">A Moolre payment link will be generated. The customer can pay via their phone, or you can open the link on your device.</p>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Card info */}
                                    {paymentMethod === 'card' && (
                                        <div className="bg-stone-50 border border-stone-200 rounded-lg p-3">
                                            <div className="flex items-start space-x-2">
                                                <i className="ri-bank-card-line text-stone-600 mt-0.5"></i>
                                                <div className="text-sm text-stone-800">
                                                    <p className="font-semibold">Card Payment</p>
                                                    <p className="mt-1">Process the card payment on your POS terminal, then tap &quot;Complete Payment&quot; to confirm.</p>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div className="p-6 border-t border-gray-100 bg-gray-50 shrink-0">
                                    <button
                                        onClick={handleCheckout}
                                        disabled={processing}
                                        className="w-full py-4 bg-gray-900 text-white rounded-xl font-bold text-lg shadow-lg hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center space-x-2"
                                    >
                                        {processing ? (
                                            <>
                                                <i className="ri-loader-4-line animate-spin"></i>
                                                <span>Processing...</span>
                                            </>
                                        ) : paymentMethod === 'momo' ? (
                                            <>
                                                <i className="ri-smartphone-line"></i>
                                                <span>Generate Payment Link</span>
                                            </>
                                        ) : (
                                            <>
                                                <i className="ri-secure-payment-line"></i>
                                                <span>Complete Payment</span>
                                            </>
                                        )}
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}

            {variantPickerProduct && (
                <div
                    className="fixed inset-0 bg-black/50 z-[55] flex items-end sm:items-center justify-center p-0 sm:p-4"
                    onClick={() => setVariantPickerProduct(null)}
                    role="presentation"
                >
                    <div
                        className="bg-white rounded-t-2xl sm:rounded-2xl w-full max-w-md max-h-[75vh] overflow-hidden flex flex-col shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="p-4 border-b border-gray-100 flex justify-between items-start gap-2 bg-gray-50 shrink-0">
                            <div className="min-w-0">
                                <h3 className="text-lg font-bold text-gray-900">Choose option</h3>
                                <p className="text-sm text-gray-600 line-clamp-2 mt-0.5">{variantPickerProduct.name}</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setVariantPickerProduct(null)}
                                className="w-9 h-9 rounded-full hover:bg-gray-200 flex items-center justify-center text-gray-500 shrink-0"
                                aria-label="Close"
                            >
                                <i className="ri-close-line text-xl"></i>
                            </button>
                        </div>
                        <div className="overflow-y-auto p-3 space-y-2 pb-6">
                            {variantPickerProduct.variants.map((v) => {
                                const disabled = v.quantity <= 0;
                                return (
                                    <button
                                        key={v.id}
                                        type="button"
                                        disabled={disabled}
                                        onClick={() => {
                                            addToCart(variantPickerProduct, v);
                                            setVariantPickerProduct(null);
                                        }}
                                        className={`w-full text-left p-3 rounded-xl border flex justify-between items-start gap-3 transition-colors ${
                                            disabled
                                                ? 'border-gray-100 bg-gray-50 opacity-60 cursor-not-allowed'
                                                : 'border-gray-200 hover:border-stone-400 hover:bg-stone-50'
                                        }`}
                                    >
                                        <span className="text-sm font-medium text-gray-900">{v.displayName}</span>
                                        <span className="text-sm font-semibold text-stone-700 shrink-0 text-right">
                                            GH₵{v.price.toFixed(2)}
                                            <span className="block text-[10px] font-normal text-gray-500 mt-0.5">
                                                {disabled ? 'Out of stock' : `${v.quantity} in stock`}
                                            </span>
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
