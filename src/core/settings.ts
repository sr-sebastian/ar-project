import type { ModeId } from './modes';

/** Calibración por cámara: cada dispositivo (webcam, celular) recuerda la suya. */
export interface CameraCalibration {
  mirror: boolean;
  /** Campo de visión horizontal en grados. */
  hfov: number;
  /** Inclinación supuesta de la cámara hacia abajo en modo mesa (si no hay profundidad). */
  tableTilt: number;
}

export interface Settings {
  mode: ModeId;
  cameraId: string;
  poseModel: 'lite' | 'full' | 'heavy';
  smoothing: boolean;
  /** Profundidad monocular (descarga ~25–100 MB la primera vez). */
  depthEnabled: boolean;
  showCursor: boolean;
  /** Lado del cuadrado negro de los marcadores impresos (m). */
  markerSizes: { table: number; floor: number };
  /** Muestra los oclusores (manos/cuerpo) en color. */
  debugOcclusion: boolean;
  calibrations: Record<string, CameraCalibration>;
}

const KEY = 'ar-proyect:settings';

export const DEFAULT_CALIBRATION: CameraCalibration = { mirror: true, hfov: 65, tableTilt: 40 };

const DEFAULTS: Settings = {
  mode: 'fullbody',
  cameraId: '',
  poseModel: 'full',
  smoothing: true,
  depthEnabled: false,
  showCursor: true,
  markerSizes: { table: 0.1, floor: 0.18 },
  debugOcclusion: false,
  calibrations: {},
};

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadSettings(): Settings {
  try {
    const raw = safeStorage()?.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings) {
  try {
    safeStorage()?.setItem(KEY, JSON.stringify(s));
  } catch {
    /* almacenamiento no disponible */
  }
}

export function calibrationFor(s: Settings, cameraKey: string): CameraCalibration {
  return { ...DEFAULT_CALIBRATION, ...s.calibrations[cameraKey] };
}

/** Lectura/escritura simple de valores sueltos (récords, etc.). */
export const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = safeStorage()?.getItem(`ar-proyect:${key}`);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      safeStorage()?.setItem(`ar-proyect:${key}`, JSON.stringify(value));
    } catch {
      /* ignorar */
    }
  },
};
