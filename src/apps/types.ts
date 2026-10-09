import type { EventBus } from '../core/EventBus';
import type { ModeConfig, ModeId } from '../core/modes';
import type { OcclusionOptions } from '../core/occlusion';
import type { Overlay2D } from '../core/Overlay2D';
import type { SceneManager } from '../core/SceneManager';
import type { HandCursor } from '../input/HandCursor';
import type { PerceptionEvents, PerceptionFrame } from '../perception/types';
import type { TrackingModule } from '../tracking/types';
import type { IconName } from '../ui/icons';

export interface AppContext {
  scene: SceneManager;
  overlay: Overlay2D;
  /** Capa HTML exclusiva de la app (se vacía al salir). */
  ui: HTMLElement;
  events: EventBus<PerceptionEvents>;
  cursor: HandCursor;
  mode: ModeConfig;
  /** Cambia los módulos de tracking activos mientras corre la app. */
  setModules(modules: TrackingModule[]): void;
  /** Activa/desactiva la estimación de profundidad (espacio 3D). */
  setDepth(enabled: boolean): void;
  readonly depthEnabled: boolean;
  /** Qué partes del usuario tapan a los objetos virtuales. */
  setOcclusion(options: Partial<OcclusionOptions>): void;
  /** Olvida la superficie medida y vuelve a buscarla. */
  recalibrate(): void;
  /** Vuelve al menú. */
  exit(): void;
  toast(message: string, ms?: number): void;
}

export interface AppInstance {
  mount(ctx: AppContext): void;
  /** `frame` es null mientras no haya tracking (cámara cargando, sin persona…). */
  update(frame: PerceptionFrame | null, dt: number): void;
  unmount(): void;
  /** Si es false, la palma abierta no saca de la app (p. ej. si el juego usa la palma). */
  allowPalmBack?: boolean;
}

export interface AppDefinition {
  id: string;
  title: string;
  icon: IconName;
  /** Color de acento de la tarjeta. */
  accent: string;
  description: string;
  kind: 'game' | 'utility';
  /** Modos en los que aparece la app. */
  modes: ModeId[];
  /** Módulos de tracking que necesita (por defecto, los del modo). */
  modules?: TrackingModule[];
  /** La app apoya contenido sobre la superficie: el shell guía la calibración. */
  usesSurface?: boolean;
  create(): AppInstance;
}
