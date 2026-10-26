import { validateHeaderValue } from 'http';
import { contentDisposition } from './content-disposition.util';

/** Splits a generated value into its parts (the format contentDisposition always produces). */
const parse = (value: string) => {
  const match = /^(inline|attachment); filename="([^"]*)"; filename\*=UTF-8''(.*)$/.exec(value);
  if (!match) throw new Error(`unexpected format: ${value}`);
  return { type: match[1], fallback: match[2], encoded: match[3], decoded: decodeURIComponent(match[3]) };
};
// RFC 5987 ext-value characters: attr-char or a %XX pct-encoded octet
const RFC5987_VALUE = /^(?:[A-Za-z0-9!#$&+\-.^_`|~]|%[0-9A-F]{2})*$/;

const NAMES = [
  'INV-2026.001.pdf',
  'Design spec (v2) [final].pdf',
  'Q3 – report.pdf',
  'ശമ്പള സർട്ടിഫിക്കറ്റ്.pdf',
  'say "hi" 100% \\ done.pdf',
  "O'Brien*~!.pdf",
  'Привет 你好 مرحبا 😀.pdf',
  'a+b=c&d;e,f{g}.pdf',
];

describe('contentDisposition', () => {
  it('keeps an ordinary ASCII name as it is in both parameters', () => {
    expect(contentDisposition('inline', 'INV-2026.001.pdf')).toBe(`inline; filename="INV-2026.001.pdf"; filename*=UTF-8''INV-2026.001.pdf`);
    expect(contentDisposition('attachment', 'a.pdf')).toBe(`attachment; filename="a.pdf"; filename*=UTF-8''a.pdf`);
  });

  it('spaces, brackets, parentheses and dots: readable fallback, every reserved character encoded', () => {
    expect(contentDisposition('inline', 'Design spec (v2) [final].pdf')).toBe(
      `inline; filename="Design spec (v2) [final].pdf"; filename*=UTF-8''Design%20spec%20%28v2%29%20%5Bfinal%5D.pdf`,
    );
  });

  it('en dash: ASCII fallback, UTF-8 bytes E2 80 93 in filename*', () => {
    expect(contentDisposition('inline', 'Q3 – report.pdf')).toBe(`inline; filename="Q3 _ report.pdf"; filename*=UTF-8''Q3%20%E2%80%93%20report.pdf`);
  });

  it('Malayalam: exact name in filename*, ASCII-only fallback that keeps the extension', () => {
    const name = 'ശമ്പള സർട്ടിഫിക്കറ്റ്.pdf';
    const { fallback, encoded, decoded } = parse(contentDisposition('inline', name));
    expect(decoded).toBe(name);
    expect(encoded.startsWith('%E0%B4%B6')).toBe(true); // ശ = U+0D36 = E0 B4 B6
    expect(fallback).toMatch(/^[\x20-\x7e]+\.pdf$/);
  });

  it('quotes, backslashes and percent signs cannot break the quoted fallback or be decoded twice', () => {
    const { fallback, encoded, decoded } = parse(contentDisposition('inline', 'say "hi" 100% \\ done.pdf'));
    expect(fallback).toBe('say _hi_ 100_ _ done.pdf');
    expect(encoded).toBe('say%20%22hi%22%20100%25%20%5C%20done.pdf');
    expect(decoded).toBe('say "hi" 100% \\ done.pdf');
  });

  it("encodes ' ( ) * (left alone by encodeURIComponent, not allowed by RFC 5987)", () => {
    expect(parse(contentDisposition('inline', "O'Brien*~!.pdf")).encoded).toBe('O%27Brien%2A~!.pdf');
  });

  it.each(NAMES)('%s: valid header, RFC 5987 value, exact round trip, ASCII fallback', (name) => {
    const value = contentDisposition('inline', name);
    expect(() => validateHeaderValue('Content-Disposition', value)).not.toThrow();
    const { fallback, encoded, decoded } = parse(value);
    expect(encoded).toMatch(RFC5987_VALUE);
    expect(decoded).toBe(name);
    expect(fallback).toMatch(/^[\x20-\x7e]+$/);
    expect(fallback).not.toMatch(/["\\%]/);
  });

  describe('header injection', () => {
    it.each([
      'evil\r\nSet-Cookie: session=stolen.pdf',
      'evil\nX-Injected: 1.pdf',
      'evil\rX-Injected: 1.pdf',
      'evil\u0000\u001b\u007f.pdf',
      'evil%0d%0aX-Injected: 1.pdf',
    ])('%j stays one header value without control characters', (name) => {
      const value = contentDisposition('inline', name);
      expect(value).not.toMatch(/[\x00-\x1f\x7f]/);
      expect(() => validateHeaderValue('Content-Disposition', value)).not.toThrow();
      expect(parse(value).decoded).not.toMatch(/[\r\n]/);
    });

    it('drops control characters rather than encoding them', () => {
      expect(contentDisposition('inline', 'a\r\nb.pdf')).toBe(`inline; filename="ab.pdf"; filename*=UTF-8''ab.pdf`);
    });
  });

  it('never throws on lone surrogates (possible in Windows names)', () => {
    const value = contentDisposition('inline', 'bad\uD800name.pdf');
    expect(parse(value).decoded).toBe('bad\uFFFDname.pdf');
  });

  it('falls back to "download" when nothing printable remains', () => {
    expect(contentDisposition('inline', '\r\n')).toBe(`inline; filename="download"; filename*=UTF-8''`);
  });
});
