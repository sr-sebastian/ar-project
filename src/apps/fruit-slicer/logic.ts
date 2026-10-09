import { seededRandom, segmentPointDistance, type Vec2 } from '../../core/math';

/**
 * Lógica pura de Fruit Slicer, sin render ni tracking (testeable).
 * Unidades: "alturas de pantalla". x ∈ [0, aspect], y ∈ [0, 1] hacia abajo.
 */
export interface Fruit {
  id: number;
  kind: 'fruit' | 'bomb';
  variant: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  spin: number;
  sliced: boolean;
  /** Ya salió de pantalla o terminó su animación. */
  dead: boolean;
}

export interface Blade {
  from: Vec2;
  to: Vec2;
  /** Velocidad de la mano (alturas/s). Por debajo del umbral no corta. */
  speed: number;
}

export interface GameInput {
  blades: Blade[];
  /** Cabeza del jugador: las bombas que la tocan explotan. */
  head: Vec2 | null;
}

export type GameEvent =
  | { type: 'slice'; fruit: Fruit; combo: number; points: number }
  | { type: 'bomb'; fruit: Fruit; reason: 'sliced' | 'head' }
  | { type: 'miss'; fruit: Fruit }
  | { type: 'spawn'; fruit: Fruit }
  | { type: 'gameover'; score: number };

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export const FRUIT_VARIANTS = 5;
const GRAVITY = 1.5;
const MIN_SLICE_SPEED = 1.1;
const COMBO_WINDOW = 0.35;

export class FruitSlicerGame {
  state: 'waiting' | 'playing' | 'over' = 'waiting';
  score = 0;
  lives = 3;
  /** Segundos de juego (escalados por la cámara lenta). */
  time = 0;
  fruits: Fruit[] = [];
  slowMoUntil = 0;
  slowMoUsed = false;
  private spawnIn = 0;
  private nextId = 1;
  private comboCount = 0;
  private lastSliceAt = -10;
  private random: () => number;

  constructor(
    public bounds: Bounds,
    seed = Date.now(),
  ) {
    this.random = seededRandom(seed);
  }

  get slowMoActive() {
    return this.time < this.slowMoUntil;
  }

  /** Dificultad crece con el tiempo: más frecuencia y más bombas. */
  get difficulty() {
    return Math.min(1, this.time / 90);
  }

  start() {
    this.state = 'playing';
    this.score = 0;
    this.lives = 3;
    this.time = 0;
    this.fruits = [];
    this.slowMoUntil = 0;
    this.slowMoUsed = false;
    this.spawnIn = 1;
    this.comboCount = 0;
  }

  /** Cámara lenta de 3 s, una vez por partida. */
  triggerSlowMo(): boolean {
    if (this.state !== 'playing' || this.slowMoUsed) return false;
    this.slowMoUsed = true;
    this.slowMoUntil = this.time + 3;
    return true;
  }

  update(realDt: number, input: GameInput): GameEvent[] {
    const events: GameEvent[] = [];
    if (this.state !== 'playing') {
      for (const f of this.fruits) this.integrate(f, realDt);
      this.fruits = this.fruits.filter((f) => !f.dead);
      return events;
    }
    const dt = this.slowMoActive ? realDt * 0.35 : realDt;
    this.time += dt;

    this.spawnIn -= dt;
    if (this.spawnIn <= 0) {
      const wave = 1 + Math.floor(this.random() * (1 + this.difficulty * 3));
      for (let i = 0; i < wave; i++) events.push({ type: 'spawn', fruit: this.spawn() });
      this.spawnIn = 1.6 - this.difficulty * 0.8 + this.random() * 0.6;
    }

    for (const f of this.fruits) {
      this.integrate(f, dt);
      if (f.sliced || f.dead) continue;

      for (const blade of input.blades) {
        if (blade.speed < MIN_SLICE_SPEED) continue;
        if (segmentPointDistance(blade.from, blade.to, f) > f.r) continue;
        f.sliced = true;
        if (f.kind === 'bomb') {
          events.push(...this.loseLife({ type: 'bomb', fruit: f, reason: 'sliced' }));
        } else {
          this.comboCount = this.time - this.lastSliceAt < COMBO_WINDOW ? this.comboCount + 1 : 1;
          this.lastSliceAt = this.time;
          const points = 10 * this.comboCount;
          this.score += points;
          events.push({ type: 'slice', fruit: f, combo: this.comboCount, points });
        }
        break;
      }

      if (!f.sliced && f.kind === 'bomb' && input.head) {
        if (Math.hypot(f.x - input.head.x, f.y - input.head.y) < f.r + 0.07) {
          f.sliced = true;
          events.push(...this.loseLife({ type: 'bomb', fruit: f, reason: 'head' }));
        }
      }
    }

    for (const f of this.fruits) {
      if (!f.dead && f.vy > 0 && f.y - f.r > this.bounds.maxY + 0.05) {
        f.dead = true;
        if (!f.sliced && f.kind === 'fruit' && this.state === 'playing') events.push(...this.loseLife({ type: 'miss', fruit: f }));
      }
    }
    this.fruits = this.fruits.filter((f) => !f.dead);
    return events;
  }

  private loseLife(ev: GameEvent): GameEvent[] {
    this.lives--;
    if (this.lives > 0) return [ev];
    this.state = 'over';
    return [ev, { type: 'gameover', score: this.score }];
  }

  private integrate(f: Fruit, dt: number) {
    f.vy += GRAVITY * dt;
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    if (f.y - f.r > this.bounds.maxY + 0.3) f.dead = true;
  }

  private spawn(): Fruit {
    const b = this.bounds;
    const width = b.maxX - b.minX;
    const height = b.maxY - b.minY;
    const x = b.minX + width * (0.15 + this.random() * 0.7);
    // Velocidad para que el pico quede entre el 15% y el 45% superior de la pantalla.
    const peakY = b.minY + height * (0.15 + this.random() * 0.3);
    const startY = b.maxY + 0.1;
    const vy = -Math.sqrt(2 * GRAVITY * (startY - peakY));
    const toCenter = (b.minX + width / 2 - x) / width;
    const bombChance = 0.1 + this.difficulty * 0.15;
    const fruit: Fruit = {
      id: this.nextId++,
      kind: this.random() < bombChance ? 'bomb' : 'fruit',
      variant: Math.floor(this.random() * FRUIT_VARIANTS),
      x,
      y: startY,
      vx: toCenter * (0.2 + this.random() * 0.3),
      vy,
      r: 0.05 + this.random() * 0.02,
      spin: (this.random() - 0.5) * 6,
      sliced: false,
      dead: false,
    };
    this.fruits.push(fruit);
    return fruit;
  }
}
