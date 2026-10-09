import { seededRandom } from '../../core/math';

/** Lógica pura de "Aplastá al Topo" (modo mesa). */
export type MolePhase = 'hidden' | 'rising' | 'up' | 'hit' | 'falling';

export interface Mole {
  phase: MolePhase;
  /** 0 = escondido, 1 = afuera del todo. */
  height: number;
  golden: boolean;
  /** Tiempo restante en la fase actual. */
  timer: number;
}

export type WhackEvent =
  | { type: 'hit'; hole: number; points: number; golden: boolean }
  | { type: 'escape'; hole: number }
  | { type: 'gameover'; score: number; hits: number; misses: number };

const RISE_TIME = 0.18;
const FALL_TIME = 0.2;
const HIT_TIME = 0.35;

export class WhackAMoleGame {
  state: 'waiting' | 'playing' | 'over' = 'waiting';
  readonly moles: Mole[];
  score = 0;
  hits = 0;
  misses = 0;
  timeLeft = 0;
  freezeUntil = 0;
  freezeUsed = false;
  private elapsed = 0;
  private spawnIn = 0;
  private random: () => number;

  constructor(
    readonly holes = 9,
    readonly duration = 60,
    seed = Date.now(),
  ) {
    this.random = seededRandom(seed);
    this.moles = Array.from({ length: holes }, () => ({ phase: 'hidden' as MolePhase, height: 0, golden: false, timer: 0 }));
  }

  get frozen() {
    return this.elapsed < this.freezeUntil;
  }

  /** Más rápido a medida que pasa el tiempo. */
  get upTime() {
    return Math.max(0.6, 1.4 - (this.elapsed / this.duration) * 0.8);
  }

  start() {
    this.state = 'playing';
    this.score = 0;
    this.hits = 0;
    this.misses = 0;
    this.elapsed = 0;
    this.timeLeft = this.duration;
    this.spawnIn = 0.6;
    this.freezeUntil = 0;
    this.freezeUsed = false;
    for (const m of this.moles) Object.assign(m, { phase: 'hidden', height: 0, timer: 0, golden: false });
  }

  /** Congela a los topos 2.5 s, una vez por partida. */
  triggerFreeze(): boolean {
    if (this.state !== 'playing' || this.freezeUsed) return false;
    this.freezeUsed = true;
    this.freezeUntil = this.elapsed + 2.5;
    return true;
  }

  /** `smashes`: índices de agujeros golpeados en este frame. */
  update(dt: number, smashes: number[]): WhackEvent[] {
    const events: WhackEvent[] = [];
    if (this.state !== 'playing') {
      this.animate(dt, events, false);
      return events;
    }
    this.elapsed += dt;
    this.timeLeft = Math.max(0, this.duration - this.elapsed);

    for (const hole of smashes) {
      const m = this.moles[hole];
      if (!m || (m.phase !== 'up' && m.phase !== 'rising') || m.height < 0.4) continue;
      const points = m.golden ? 30 : 10;
      this.score += points;
      this.hits++;
      m.phase = 'hit';
      m.timer = HIT_TIME;
      events.push({ type: 'hit', hole, points, golden: m.golden });
    }

    if (!this.frozen) {
      this.spawnIn -= dt;
      if (this.spawnIn <= 0) {
        this.popRandom();
        const progress = this.elapsed / this.duration;
        this.spawnIn = 0.9 - progress * 0.5 + this.random() * 0.4;
      }
    }
    this.animate(dt, events, true);

    if (this.timeLeft <= 0) {
      this.state = 'over';
      events.push({ type: 'gameover', score: this.score, hits: this.hits, misses: this.misses });
    }
    return events;
  }

  private popRandom() {
    const free = this.moles.map((m, i) => (m.phase === 'hidden' ? i : -1)).filter((i) => i >= 0);
    if (free.length === 0) return;
    const m = this.moles[free[Math.floor(this.random() * free.length)]];
    m.phase = 'rising';
    m.timer = RISE_TIME;
    m.golden = this.random() < 0.12;
  }

  private animate(dt: number, events: WhackEvent[], playing: boolean) {
    const frozen = this.frozen;
    this.moles.forEach((m, hole) => {
      if (frozen && (m.phase === 'up' || m.phase === 'rising')) return;
      m.timer -= dt;
      switch (m.phase) {
        case 'rising':
          m.height = Math.min(1, 1 - m.timer / RISE_TIME);
          if (m.timer <= 0) {
            m.phase = 'up';
            m.timer = this.upTime * (m.golden ? 0.6 : 1);
          }
          break;
        case 'up':
          if (m.timer <= 0 || !playing) {
            m.phase = 'falling';
            m.timer = FALL_TIME;
            if (playing) {
              this.misses++;
              events.push({ type: 'escape', hole });
            }
          }
          break;
        case 'hit':
        case 'falling': {
          const total = m.phase === 'hit' ? HIT_TIME : FALL_TIME;
          m.height = Math.max(0, m.timer / total) * (m.phase === 'hit' ? 0.6 : 1);
          if (m.timer <= 0) {
            m.phase = 'hidden';
            m.height = 0;
          }
          break;
        }
      }
    });
  }
}
