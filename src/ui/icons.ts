import {
  Activity,
  ArrowLeft,
  Bomb,
  Boxes,
  Camera,
  Check,
  Crosshair,
  Gauge,
  Hand,
  Hammer,
  Heart,
  Layers,
  LampDesk,
  Microscope,
  PersonStanding,
  Play,
  Printer,
  RotateCcw,
  ScanLine,
  Settings,
  Smartphone,
  Snowflake,
  Sparkles,
  Swords,
  Timer,
  Trophy,
  Turtle,
  X,
  createElement,
  type IconNode,
} from 'lucide';

/**
 * Íconos SVG de la interfaz (Lucide). Se importan sólo los usados para que el bundle
 * quede chico. `icon()` devuelve el SVG como texto para usar en plantillas.
 */
const ICONS = {
  activity: Activity,
  back: ArrowLeft,
  bomb: Bomb,
  blocks: Boxes,
  camera: Camera,
  check: Check,
  recalibrate: Crosshair,
  gauge: Gauge,
  hand: Hand,
  hammer: Hammer,
  heart: Heart,
  layers: Layers,
  table: LampDesk,
  microscope: Microscope,
  body: PersonStanding,
  play: Play,
  printer: Printer,
  reset: RotateCcw,
  scan: ScanLine,
  settings: Settings,
  phone: Smartphone,
  freeze: Snowflake,
  sparkles: Sparkles,
  katana: Swords,
  timer: Timer,
  trophy: Trophy,
  slow: Turtle,
  close: X,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 20, strokeWidth = 2): string {
  const el = createElement(ICONS[name], { width: size, height: size, 'stroke-width': strokeWidth, 'aria-hidden': 'true' });
  el.classList.add('icon');
  return el.outerHTML;
}
