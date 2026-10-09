import type { SurfaceKind } from '../perception/space/surface';
import type { TrackingModule } from '../tracking/types';
import type { IconName } from '../ui/icons';

export type ModeId = 'fullbody' | 'table';

export interface ModeConfig {
  id: ModeId;
  title: string;
  icon: IconName;
  description: string;
  /** Superficie de juego que se detecta en este modo. */
  surface: SurfaceKind;
  /** Módulos de tracking por defecto para las apps del modo. */
  modules: TrackingModule[];
  /** Cómo ubicar la cámara. */
  setupHint: string;
}

export const MODES: Record<ModeId, ModeConfig> = {
  fullbody: {
    id: 'fullbody',
    title: 'Cuerpo completo',
    icon: 'body',
    description: 'Jugás de pie frente a la cámara. La superficie es el piso.',
    surface: 'floor',
    modules: ['pose', 'hands', 'face'],
    setupHint: 'Alejate 2–3 m de la cámara hasta que se vea todo tu cuerpo, pies incluidos. Para máxima precisión, poné el marcador de piso en el suelo.',
  },
  table: {
    id: 'table',
    title: 'Mesa',
    icon: 'table',
    description: 'La cámara mira una mesa y jugás con las manos sobre ella. La superficie es la mesa.',
    surface: 'table',
    modules: ['hands', 'face'],
    setupHint: 'Apuntá la cámara a la mesa en diagonal o desde arriba. Para fijar la mesa, apoyá el marcador impreso o la mano abierta un segundo.',
  },
};
