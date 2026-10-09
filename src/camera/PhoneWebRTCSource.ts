import type { Vec3 } from '../core/math';
import type { CameraSource } from './CameraSource';
import { connectSignaling, RTC_CONFIG, type MotionMessage, type SignalMessage } from './signaling';

export type PhoneStatus = 'waiting' | 'connecting' | 'connected' | 'disconnected' | 'error';

/**
 * Recibe la cámara de un celular por WebRTC. El PC crea una sala, muestra un QR con
 * `phone.html?room=XXXX`, el celular abre la página y ofrece su cámara.
 */
export class PhoneWebRTCSource implements CameraSource {
  readonly kind = 'phone' as const;
  readonly label = 'Celular (WebRTC)';
  readonly key = 'phone:webrtc';
  onEnded: () => void = () => {};
  onStatus: (s: PhoneStatus) => void = () => {};
  /** Vertical (opuesto a la gravedad) en coordenadas de cámara. */
  onUp: (up: Vec3) => void = () => {};
  /** Se llama si el celular se reconecta y llega un stream nuevo después del primero. */
  onStream: (stream: MediaStream) => void = () => {};

  private pc: RTCPeerConnection | null = null;
  private signaling: ReturnType<typeof connectSignaling> | null = null;

  constructor(readonly room: string) {}

  start(): Promise<MediaStream> {
    this.onStatus('waiting');
    return new Promise<MediaStream>((resolve, reject) => {
      let resolved = false;
      const pending: RTCIceCandidateInit[] = [];
      const handle = async (msg: SignalMessage) => {
        if (msg.type === 'peer-left') {
          this.onStatus('disconnected');
          this.onEnded();
          return;
        }
        if (msg.type !== 'signal') return;
        const data = msg.data;
        if (data.kind === 'offer') {
          this.onStatus('connecting');
          this.pc?.close();
          const pc = new RTCPeerConnection(RTC_CONFIG);
          this.pc = pc;
          pc.onicecandidate = (e) => e.candidate && this.signaling?.send({ kind: 'ice', candidate: e.candidate.toJSON() });
          pc.ontrack = (e) => {
            const stream = e.streams[0] ?? new MediaStream([e.track]);
            this.onStatus('connected');
            if (resolved) this.onStream(stream);
            else {
              resolved = true;
              resolve(stream);
            }
          };
          pc.ondatachannel = (e) => {
            e.channel.onmessage = (m) => {
              const motion = JSON.parse(String(m.data)) as MotionMessage;
              if (motion.type === 'up') this.onUp({ x: motion.x, y: motion.y, z: motion.z });
            };
          };
          pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
              this.onStatus('disconnected');
              this.onEnded();
            }
          };
          await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
          for (const c of pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.signaling?.send({ kind: 'answer', sdp: answer.sdp ?? '' });
        } else if (data.kind === 'ice') {
          if (this.pc?.remoteDescription) await this.pc.addIceCandidate(data.candidate).catch(() => {});
          else pending.push(data.candidate);
        }
      };
      this.signaling = connectSignaling(this.room, 'pc', (m) => void handle(m));
      this.signaling.ready.catch((err) => {
        this.onStatus('error');
        reject(err);
      });
    });
  }

  stop() {
    this.pc?.close();
    this.pc = null;
    this.signaling?.close();
    this.signaling = null;
  }
}

/** URL que abre el celular. Usa la IP de la LAN si el PC está en localhost. */
export async function phoneUrl(room: string): Promise<string> {
  let host = location.host;
  if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
    try {
      const { addresses } = (await (await fetch('/api/lan')).json()) as { addresses: string[] };
      if (addresses[0]) host = `${addresses[0]}${location.port ? `:${location.port}` : ''}`;
    } catch {
      /* sin endpoint: se usa el host actual */
    }
  }
  return `${location.protocol}//${host}${import.meta.env.BASE_URL}phone.html?room=${room}`;
}
