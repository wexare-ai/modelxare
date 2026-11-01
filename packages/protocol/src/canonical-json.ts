/**
 * Deterministic JSON serializer (RFC 8785-style): object keys sorted by UTF-16
 * code units, no insignificant whitespace, ECMAScript number formatting.
 *
 * Publishers use it to produce manifest bytes. Verifiers never re-serialize:
 * they hash the exact string carried in the event.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, []);
}

function serialize(value: unknown, path: (string | number)[]): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${fmt(path)}`);
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((v, i) => serialize(v, [...path, i])).join(',') + ']';
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`Unsupported object type at ${fmt(path)}`);
      }
      const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + serialize(v, [...path, k])).join(',') + '}';
    }
    default:
      throw new TypeError(`Unsupported value of type ${typeof value} at ${fmt(path)}`);
  }
}

function fmt(path: (string | number)[]): string {
  return path.length ? path.join('.') : '<root>';
}
