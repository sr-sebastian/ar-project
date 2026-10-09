import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Http2SecureServer } from 'node:http2';
import { networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import type { Plugin } from 'vite';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * Servidor de señalización WebRTC mínimo para conectar un celular (emisor de cámara)
 * con el PC (receptor). Funciona por "salas": el PC crea una sala, el celular se une
 * y todo mensaje se reenvía al otro par de la sala.
 *
 * Protocolo (JSON):
 *   → { type: 'join', room, role: 'pc' | 'phone' }
 *   ← { type: 'peer-joined', role } / { type: 'peer-left', role }
 *   ↔ { type: 'signal', data }   (ofertas, respuestas y candidatos ICE)
 */
type Role = 'pc' | 'phone';
interface Peer {
  socket: WebSocket;
  role: Role;
}

export const SIGNAL_PATH = '/signal';

function createSignalingServer() {
  const wss = new WebSocketServer({ noServer: true });
  const rooms = new Map<string, Map<Role, Peer>>();

  const send = (socket: WebSocket, msg: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };

  wss.on('connection', (socket) => {
    let room: string | null = null;
    let role: Role | null = null;

    socket.on('message', (raw) => {
      let msg: { type?: string; room?: string; role?: Role; data?: unknown };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (msg.type === 'join' && typeof msg.room === 'string' && (msg.role === 'pc' || msg.role === 'phone')) {
        room = msg.room.slice(0, 32);
        role = msg.role;
        const peers = rooms.get(room) ?? new Map<Role, Peer>();
        rooms.set(room, peers);
        peers.get(role)?.socket.close();
        peers.set(role, { socket, role });
        const other = peers.get(role === 'pc' ? 'phone' : 'pc');
        if (other) {
          send(other.socket, { type: 'peer-joined', role });
          send(socket, { type: 'peer-joined', role: other.role });
        }
        return;
      }

      if (msg.type === 'signal' && room && role) {
        const other = rooms.get(room)?.get(role === 'pc' ? 'phone' : 'pc');
        if (other) send(other.socket, { type: 'signal', data: msg.data });
      }
    });

    socket.on('close', () => {
      if (!room || !role) return;
      const peers = rooms.get(room);
      if (peers?.get(role)?.socket !== socket) return;
      peers.delete(role);
      const other = peers.get(role === 'pc' ? 'phone' : 'pc');
      if (other) send(other.socket, { type: 'peer-left', role });
      if (peers.size === 0) rooms.delete(room);
    });
  });

  return {
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    },
  };
}

/** IPs IPv4 de la LAN, para armar la URL del QR que abre el celular. */
export function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

/**
 * Node 22.21.0 (y 24.9.x) agregaron `shouldUpgradeCallback` a http.Server pero no a los
 * servidores HTTP/2 con `allowHTTP1` que usa Vite con HTTPS: cualquier WebSocket (HMR o
 * señalización) tira "server.shouldUpgradeCallback is not a function" y mata el proceso.
 * Arreglado en Node 22.22; mientras tanto definimos el callback con su valor por defecto.
 */
function patchUpgradeCallback(httpServer: HttpServer | Http2SecureServer) {
  const server = httpServer as unknown as { shouldUpgradeCallback?: unknown; listenerCount(event: string): number };
  if (typeof server.shouldUpgradeCallback === 'function') return;
  server.shouldUpgradeCallback = function (this: typeof server) {
    return this.listenerCount('upgrade') > 0;
  };
}

function attach(httpServer: HttpServer | Http2SecureServer | null) {
  if (!httpServer) return;
  patchUpgradeCallback(httpServer);
  const signaling = createSignalingServer();
  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (req.url?.startsWith(SIGNAL_PATH)) signaling.handleUpgrade(req, socket, head);
  });
}

/** Plugin de Vite: señalización por WebSocket + endpoint `/api/lan` en dev y preview. */
export function signalingPlugin(): Plugin {
  const lanMiddleware = (req: IncomingMessage, res: import('node:http').ServerResponse, next: () => void) => {
    if (req.url !== '/api/lan') return next();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ addresses: lanAddresses() }));
  };
  return {
    name: 'ar-signaling',
    configureServer(server) {
      server.middlewares.use(lanMiddleware);
      attach(server.httpServer);
    },
    configurePreviewServer(server) {
      server.middlewares.use(lanMiddleware);
      attach(server.httpServer);
    },
  };
}
