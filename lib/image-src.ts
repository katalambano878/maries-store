/**
 * Turn this store's own storage URLs into same-site paths for <Image>.
 *
 * Product photos are stored as absolute URLs (https://www.shopmarieshair.com/
 * storage/v1/object/public/...). next/image fetches absolute URLs over the
 * internet with a 7 s limit, which the 2–3 MB originals miss when a page asks
 * for many at once, so the photos came back broken. A same-site path is read
 * from disk inside the server instead.
 */
const OWN_STORAGE =
    /^https?:\/\/(?:www\.)?(?:shopmarieshair\.com|marieshair\.169-58-8-203\.sslip\.io)(?=\/storage\/v1\/object\/public\/)/i;

export function localImage<T>(src: T): T {
    return (typeof src === 'string' ? src.replace(OWN_STORAGE, '') : src) as T;
}

/**
 * A resized copy of one of the store's own photos for a plain <img>
 * thumbnail (admin lists, POS, search), instead of the 2–3 MB original.
 * `width` must be one of next.config's image sizes (e.g. 128, 256, 640).
 * Other URLs (external, data:, blob: previews) are returned unchanged.
 */
export function thumbSrc(src: string | null | undefined, width: 128 | 256 | 640 = 256): string {
    if (!src) return '';
    const local = localImage(src);
    if (!local.startsWith('/storage/v1/object/public/')) return src;
    return `/_next/image?url=${encodeURIComponent(local)}&w=${width}&q=75`;
}
