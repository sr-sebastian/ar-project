import { connectSignaling, RTC_CONFIG, type MotionMessage, type SignalMessage } from '../camera/signaling';
import { deviceUpToCamera } from './motion';

/** Página del celular: manda su cámara (y la vertical del acelerómetro) al PC por WebRTC. */
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const statusEl = $('#status');
const startBtn = $<HTMLButtonElement>('#start');
const flipBtn = $<HTMLButtonElement>('#flip');
const preview = $<HTMLVideoElement>('#preview');
const room = new URLSearchParams(location.search).get('room') ?? '';

let facing: 'environment' | 'user' = 'environment';
let stream: MediaStream | null = null;
let pc: RTCPeerConnection | null = null;
let channel: RTCDataChannel | null = null;
let signaling: ReturnType<typeof connectSignaling> | null = null;

const setStatus = (s: string) => (statusEl.textContent = s);

if (!room) setStatus('Falta el código de sala. Escaneá el QR desde el PC.');
if (!window.isSecureContext) setStatus('Esta página necesita HTTPS para usar la cámara.');

async function openCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  });
  preview.srcObject = stream;
  preview.style.transform = facing === 'user' ? 'scaleX(-1)' : '';
}

async function call() {
  pc?.close();
  pc = new RTCPeerConnection(RTC_CONFIG);
  channel = pc.createDataChannel('motion', { ordered: false, maxRetransmits: 0 });
  stream!.getTracks().forEach((t) => pc!.addTrack(t, stream!));
  pc.onicecandidate = (e) => e.candidate && signaling?.send({ kind: 'ice', candidate: e.candidate.toJSON() });
  pc.onconnectionstatechange = () => {
    const state = pc?.connectionState;
    if (state === 'connected') setStatus(`✅ Conectado al PC (sala ${room}). Dejá esta pestaña abierta.`);
    else if (state === 'failed' || state === 'disconnected') setStatus('Conexión perdida. Tocá "Conectar" otra vez.');
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  signaling?.send({ kind: 'offer', sdp: offer.sdp ?? '' });
  setStatus('Conectando…');
}

function onSignal(msg: SignalMessage) {
  if (msg.type === 'peer-joined' && msg.role === 'pc' && stream) void call();
  if (msg.type === 'peer-left') setStatus('El PC se desconectó. Esperando…');
  if (msg.type !== 'signal' || !pc) return;
  if (msg.data.kind === 'answer') void pc.setRemoteDescription({ type: 'answer', sdp: msg.data.sdp });
  else if (msg.data.kind === 'ice') void pc.addIceCandidate(msg.data.candidate).catch(() => {});
}

async function enableMotion() {
  const DME = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> };
  if (typeof DME.requestPermission === 'function') {
    if ((await DME.requestPermission().catch(() => 'denied')) !== 'granted') return;
  }
  let last = 0;
  window.addEventListener('devicemotion', (e) => {
    const a = e.accelerationIncludingGravity;
    const now = performance.now();
    if (!a || a.x === null || a.y === null || a.z === null || now - last < 100) return;
    last = now;
    if (channel?.readyState !== 'open') return;
    const up = deviceUpToCamera({ x: a.x, y: a.y, z: a.z }, screen.orientation?.angle ?? 0, facing);
    const msg: MotionMessage = { type: 'up', ...up };
    channel.send(JSON.stringify(msg));
  });
}

startBtn.onclick = async () => {
  startBtn.disabled = true;
  try {
    await openCamera();
    await enableMotion();
    signaling?.close();
    signaling = connectSignaling(room, 'phone', onSignal);
    await signaling.ready;
    await call();
    flipBtn.hidden = false;
    startBtn.textContent = 'Reconectar';
  } catch (err) {
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    startBtn.disabled = false;
  }
};

flipBtn.onclick = async () => {
  facing = facing === 'environment' ? 'user' : 'environment';
  await openCamera();
  // Reemplaza la pista sin renegociar la conexión.
  const track = stream!.getVideoTracks()[0];
  const sender = pc?.getSenders().find((s) => s.track?.kind === 'video');
  if (sender) await sender.replaceTrack(track);
  else await call();
};
