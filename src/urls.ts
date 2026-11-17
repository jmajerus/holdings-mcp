/**
 * URL parts written for people to read. A key such as main:53, quote:761 or @smith2020 keeps its `:` and `@`,
 * which are legal in a path segment and a query; everything else is encoded as usual.
 */
const readable = (encoded: string) => encoded.replace(/%(3A|40)/gi, (m) => decodeURIComponent(m));

/** One path segment: /books/main:53, not /books/main%3A53. */
export const pathSegment = (value: string): string => readable(encodeURIComponent(value));

/** One query value, with a space as `+` and `/` and `,` also left as they are. */
export const queryValue = (value: string): string => readable(encodeURIComponent(value)).replace(/%20/g, "+").replace(/%(2F|2C)/gi, (m) => decodeURIComponent(m));
