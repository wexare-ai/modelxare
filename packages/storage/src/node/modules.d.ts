declare module 'create-torrent' {
  const createTorrent: (input: unknown, opts: unknown, cb: (err: Error | null, torrent: Uint8Array) => void) => void;
  export default createTorrent;
}
declare module 'parse-torrent' {
  const parseTorrent: (input: Uint8Array | string) => Promise<{ infoHash: string; name?: string; files?: { path: string; length: number }[] }>;
  export default parseTorrent;
  export function toMagnetURI(parsed: unknown): string;
}
