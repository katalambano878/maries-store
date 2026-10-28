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
