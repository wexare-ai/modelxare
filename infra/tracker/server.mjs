// Local WebTorrent-compatible tracker (HTTP + WebSocket signaling) for the weXare PoC.
// Browsers find WebRTC peers through the WebSocket endpoint; no UDP.
import Server from 'bittorrent-tracker/server';

const port = Number(process.env.TRACKER_PORT ?? 8000);
const server = new Server({ udp: false, http: true, ws: true, stats: true, trustProxy: false });

server.on('error', (err) => console.error('tracker error:', err.message));
server.on('warning', (err) => console.warn('tracker warning:', err.message));
server.on('start', (addr, params) => console.log(`start ${params.info_hash ?? ''} from ${addr}`));
server.on('listening', () => console.log(`tracker listening on :${port} (http /announce, ws /, stats /stats.json)`));
server.listen(port, '0.0.0.0');

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
