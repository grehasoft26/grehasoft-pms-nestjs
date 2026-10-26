/**
 * Content-Disposition value for a file name (RFC 6266): `filename` is an ASCII-only fallback,
 * `filename*` the exact name as percent-encoded UTF-8 (RFC 5987/8187). Works for any name
 * (Malayalam, en dashes, quotes, percent signs); control characters, CR/LF included, are dropped,
 * so the name can never end the header or start another one.
 */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const name = String(filename ?? '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    // Lone UTF-16 surrogates (possible in Windows file names) cannot be encoded as UTF-8
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
  // Quotes and backslashes would end or escape the quoted string; "%" may be decoded by some browsers
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_').trim() || 'download';
  // encodeURIComponent leaves ' ( ) * as they are, but RFC 5987 attr-char does not allow them
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
