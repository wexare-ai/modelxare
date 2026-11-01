// Minimal GGUF header reader: reads the leading key/value metadata (enough for
// general.architecture / general.type / adapter.type) without loading tensors.

const TYPE_SIZES: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

export interface GgufHeader {
  version: number;
  tensorCount: number;
  metadata: Record<string, string | number | boolean>;
  /** True when the read window ended before all key/value pairs were parsed. */
  truncated: boolean;
}

export async function readGgufHeader(blob: Blob, windowBytes = 1 << 20, wanted?: string[]): Promise<GgufHeader> {
  const buf = new DataView(await blob.slice(0, windowBytes).arrayBuffer());
  let off = 0;
  const need = (n: number) => {
    if (off + n > buf.byteLength) throw new RangeError('window');
  };
  const u32 = () => (need(4), (off += 4), buf.getUint32(off - 4, true));
  const u64 = () => (need(8), (off += 8), Number(buf.getBigUint64(off - 8, true)));
  const str = () => {
    const n = u64();
    need(n);
    const s = new TextDecoder().decode(new Uint8Array(buf.buffer, buf.byteOffset + off, n));
    off += n;
    return s;
  };
  const magic = u32();
  if (magic !== 0x46554747) throw new Error('not a GGUF file');
  const version = u32();
  const tensorCount = u64();
  const kvCount = u64();
  const metadata: GgufHeader['metadata'] = {};
  const scalar = (t: number): string | number | boolean | undefined => {
    switch (t) {
      case 0: return (need(1), (off += 1), buf.getUint8(off - 1));
      case 1: return (need(1), (off += 1), buf.getInt8(off - 1));
      case 2: return (need(2), (off += 2), buf.getUint16(off - 2, true));
      case 3: return (need(2), (off += 2), buf.getInt16(off - 2, true));
      case 4: return u32();
      case 5: return (need(4), (off += 4), buf.getInt32(off - 4, true));
      case 6: return (need(4), (off += 4), buf.getFloat32(off - 4, true));
      case 7: return (need(1), (off += 1), buf.getUint8(off - 1) !== 0);
      case 8: return str();
      case 10: return u64();
      case 11: return (need(8), (off += 8), Number(buf.getBigInt64(off - 8, true)));
      case 12: return (need(8), (off += 8), buf.getFloat64(off - 8, true));
      default: throw new Error(`unsupported GGUF value type ${t}`);
    }
  };
  let truncated = false;
  try {
    for (let i = 0; i < kvCount; i++) {
      const key = str();
      const type = u32();
      if (type === 9) {
        const itemType = u32();
        const count = u64();
        if (itemType === 8) for (let j = 0; j < count; j++) str();
        else {
          const size = TYPE_SIZES[itemType];
          if (size === undefined) throw new Error(`unsupported GGUF array type ${itemType}`);
          need(size * count);
          off += size * count;
        }
      } else {
        const v = scalar(type);
        if (v !== undefined) metadata[key] = v;
      }
      if (wanted && wanted.every((k) => k in metadata)) break;
    }
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    truncated = true;
  }
  return { version, tensorCount, metadata, truncated };
}

/** Check that an adapter file is a LoRA for the same architecture as the base weights. */
export async function checkAdapterCompatibility(base: Blob, adapter: Blob): Promise<{ ok: boolean; reason: string }> {
  const keys = ['general.architecture', 'general.type'];
  const [b, a] = await Promise.all([readGgufHeader(base, 1 << 20, keys), readGgufHeader(adapter, 1 << 20, [...keys, 'adapter.type'])]);
  const archB = b.metadata['general.architecture'];
  const archA = a.metadata['general.architecture'];
  if (a.metadata['general.type'] !== 'adapter' || a.metadata['adapter.type'] !== 'lora') return { ok: false, reason: 'adapter file is not a GGUF LoRA adapter' };
  if (!archA || !archB) return { ok: false, reason: 'architecture metadata missing' };
  if (archA !== archB) return { ok: false, reason: `adapter architecture ${archA} does not match base ${archB}` };
  return { ok: true, reason: `GGUF LoRA adapter for ${archA}` };
}
