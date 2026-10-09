import { describe, expect, it } from 'vitest';
import { bladeSweepHits, FruitSlicerGame } from '../src/apps/fruit-slicer/logic';
import { WhackAMoleGame } from '../src/apps/whack-a-mole/logic';

const bounds = { minX: 0, maxX: 16 / 9, minY: 0, maxY: 1 };
const noInput = { blades: [], head: null };

function runUntilFruit(game: FruitSlicerGame, kind: 'fruit' | 'bomb') {
  // Vidas de sobra para que las frutas perdidas no terminen la partida antes de tiempo.
  game.lives = 1000;
  for (let i = 0; i < 2000; i++) {
    game.update(1 / 60, noInput);
    const f = game.fruits.find((x) => x.kind === kind && !x.sliced && x.y < 0.8);
    if (f) return f;
  }
  throw new Error(`no apareció ${kind}`);
}

describe('FruitSlicerGame', () => {
  it('cortar una fruta rápido suma puntos', () => {
    const g = new FruitSlicerGame(bounds, 7);
    g.start();
    const f = runUntilFruit(g, 'fruit');
    const ev = g.update(1 / 60, { blades: [{ from: { x: f.x - 0.2, y: f.y }, to: { x: f.x + 0.2, y: f.y }, speed: 3 }], head: null });
    expect(ev.some((e) => e.type === 'slice')).toBe(true);
    expect(g.score).toBeGreaterThan(0);
  });

  it('un movimiento lento no corta', () => {
    const g = new FruitSlicerGame(bounds, 7);
    g.start();
    const f = runUntilFruit(g, 'fruit');
    g.update(1 / 60, { blades: [{ from: { x: f.x, y: f.y }, to: { x: f.x, y: f.y }, speed: 0.2 }], head: null });
    expect(g.score).toBe(0);
  });

  it('cortar una bomba resta una vida', () => {
    const g = new FruitSlicerGame(bounds, 11);
    g.start();
    const b = runUntilFruit(g, 'bomb');
    const lives = g.lives;
    g.update(1 / 60, { blades: [{ from: { x: b.x - 0.2, y: b.y }, to: { x: b.x + 0.2, y: b.y }, speed: 3 }], head: null });
    expect(g.lives).toBe(lives - 1);
    expect(g.score).toBe(0);
  });

  it('dejar caer frutas termina el juego', () => {
    const g = new FruitSlicerGame(bounds, 3);
    g.start();
    let over = false;
    for (let i = 0; i < 60 * 120 && !over; i++) over = g.update(1 / 60, noInput).some((e) => e.type === 'gameover');
    expect(over).toBe(true);
    expect(g.state).toBe('over');
  });

  it('la cámara lenta se usa una sola vez', () => {
    const g = new FruitSlicerGame(bounds, 3);
    g.start();
    expect(g.triggerSlowMo()).toBe(true);
    expect(g.slowMoActive).toBe(true);
    expect(g.triggerSlowMo()).toBe(false);
  });
});

describe('WhackAMoleGame', () => {
  it('golpear un topo afuera suma puntos', () => {
    const g = new WhackAMoleGame(9, 60, 5);
    g.start();
    let hole = -1;
    for (let i = 0; i < 600 && hole < 0; i++) {
      g.update(1 / 60, []);
      hole = g.moles.findIndex((m) => m.phase === 'up');
    }
    expect(hole).toBeGreaterThanOrEqual(0);
    const ev = g.update(1 / 60, [hole]);
    expect(ev[0]).toMatchObject({ type: 'hit', hole });
    expect(g.score).toBeGreaterThan(0);
  });

  it('golpear un agujero vacío no suma', () => {
    const g = new WhackAMoleGame(9, 60, 5);
    g.start();
    g.update(0.01, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(g.score).toBe(0);
  });

  it('termina al acabarse el tiempo', () => {
    const g = new WhackAMoleGame(9, 5, 5);
    g.start();
    let over = false;
    for (let i = 0; i < 60 * 6 && !over; i++) over = g.update(1 / 60, []).some((e) => e.type === 'gameover');
    expect(over).toBe(true);
    expect(g.misses).toBeGreaterThan(0);
  });

  it('congelar detiene a los topos', () => {
    const g = new WhackAMoleGame(9, 60, 5);
    g.start();
    while (!g.moles.some((m) => m.phase === 'up')) g.update(1 / 60, []);
    expect(g.triggerFreeze()).toBe(true);
    const outside = g.moles.map((m, i) => (m.phase === 'up' ? i : -1)).filter((i) => i >= 0);
    g.update(1, []);
    // Los topos que estaban afuera siguen afuera y no aparece ninguno nuevo.
    for (const i of outside) expect(g.moles[i].phase).toBe('up');
    expect(g.moles.filter((m) => m.phase === 'up' || m.phase === 'rising').length).toBe(outside.length);
    expect(g.triggerFreeze()).toBe(false);
  });
});

describe('bladeSweepHits (katana)', () => {
  it('detecta una fruta dentro del área barrida aunque esté lejos de la punta', () => {
    const sweep = { prevBase: { x: 0, y: 1 }, prevTip: { x: 0, y: 0 }, base: { x: 0.5, y: 1 }, tip: { x: 0.5, y: 0 } };
    expect(bladeSweepHits(sweep, { x: 0.25, y: 0.5 }, 0.01)).toBe(true);
    expect(bladeSweepHits(sweep, { x: 0.8, y: 0.5 }, 0.05)).toBe(false);
    expect(bladeSweepHits(sweep, { x: 0.53, y: 0.5 }, 0.05)).toBe(true);
  });

  it('una katana rápida corta en el juego', () => {
    const g = new FruitSlicerGame(bounds, 7);
    g.start();
    const f = runUntilFruit(g, 'fruit');
    const ev = g.update(1 / 60, {
      blades: [],
      head: null,
      sweeps: [{ prevBase: { x: f.x - 0.3, y: f.y + 0.4 }, prevTip: { x: f.x - 0.3, y: f.y - 0.4 }, base: { x: f.x + 0.3, y: f.y + 0.4 }, tip: { x: f.x + 0.3, y: f.y - 0.4 }, speed: 4 }],
    });
    expect(ev.some((e) => e.type === 'slice')).toBe(true);
  });
});
