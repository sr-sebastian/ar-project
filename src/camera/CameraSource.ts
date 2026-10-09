/**
 * Toda fuente de cámara entrega un MediaStream. Después de esto el pipeline es idéntico,
 * sea una webcam, un celular con app de "cámara virtual" o un celular por WebRTC.
 */
export interface CameraSource {
  readonly kind: 'device' | 'phone';
  /** Clave estable para guardar la calibración de esta cámara. */
  readonly key: string;
  readonly label: string;
  start(): Promise<MediaStream>;
  stop(): void;
  /** Se dispara si la fuente se corta (celular desconectado, cámara desenchufada). */
  onEnded: () => void;
}

export interface CameraDeviceInfo {
  deviceId: string;
  label: string;
}

export async function listCameras(): Promise<CameraDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Cámara ${i + 1}` }));
}

/** Webcam o celular expuesto como cámara del sistema (DroidCam, Iriun, Camo, Continuity, Phone Link…). */
export class DeviceCameraSource implements CameraSource {
  readonly kind = 'device' as const;
  private stream: MediaStream | null = null;
  onEnded: () => void = () => {};

  constructor(
    private deviceId: string,
    public label = 'Cámara',
  ) {}

  get key() {
    // El label es más estable que el deviceId entre sesiones/navegadores.
    return `device:${this.label}`;
  }

  async start(): Promise<MediaStream> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: this.deviceId ? { exact: this.deviceId } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
    });
    const track = this.stream.getVideoTracks()[0];
    if (track?.label) this.label = track.label;
    track?.addEventListener('ended', () => this.onEnded());
    return this.stream;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
