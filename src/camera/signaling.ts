/** Cliente del servidor de señalización (ver server/signaling.ts). */
export type SignalData =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit };

export type SignalMessage =
  | { type: 'peer-joined'; role: 'pc' | 'phone' }
  | { type: 'peer-left'; role: 'pc' | 'phone' }
  | { type: 'signal'; data: SignalData };

export function connectSignaling(room: string, role: 'pc' | 'phone', onMessage: (m: SignalMessage) => void) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/signal`);
  const ready = new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', room, role }));
      resolve();
    };
    ws.onerror = () => reject(new Error('No se pudo conectar al servidor de señalización'));
  });
  ws.onmessage = (e) => {
    try {
      onMessage(JSON.parse(String(e.data)) as SignalMessage);
    } catch {
      /* ignorar */
    }
  };
  return {
    ready,
    socket: ws,
    send: (data: SignalData) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'signal', data }));
    },
    close: () => ws.close(),
  };
}

export const RTC_CONFIG: RTCConfiguration = {
  // En la misma LAN alcanza con candidatos "host"; el STUN ayuda si hay NAT/VLAN de por medio.
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

/** Mensaje de sensores que el celular manda por DataChannel. */
export interface MotionMessage {
  type: 'up';
  /** Vertical (opuesta a la gravedad) en coordenadas de la cámara del celular (x derecha, y abajo, z adelante), normalizada. */
  x: number;
  y: number;
  z: number;
}

export function randomRoom() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => alphabet[b % alphabet.length]).join('');
}
