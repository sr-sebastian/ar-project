import * as THREE from 'three';
import { dimpleBump, fleshTexture, speckledTexture, watermelonTexture } from './textures';

/**
 * Frutas procedurales con materiales PBR. Todas se construyen con radio 1 (unidad) y se
 * escalan al tamaño real; el origen está en el centro de la fruta.
 */
export type FruitKind = 'watermelon' | 'apple' | 'orange' | 'lemon' | 'peach';
export const FRUIT_KINDS: FruitKind[] = ['watermelon', 'apple', 'orange', 'lemon', 'peach'];

interface FruitSpec {
  /** Escala por eje (forma). */
  shape: [number, number, number];
  skin: () => THREE.MeshPhysicalMaterial;
  flesh: () => THREE.MeshStandardMaterial;
  /** Color del jugo (salpicaduras). */
  juice: string;
}

const lathe = (profile: [number, number][], segments = 40) =>
  new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), segments);

/** Perfil de manzana (con hundimientos arriba y abajo) para LatheGeometry. */
function appleGeometry() {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 32; i++) {
    const t = i / 32; // 0 abajo → 1 arriba
    const a = -Math.PI / 2 + t * Math.PI;
    let r = Math.cos(a) * (1 + 0.08 * Math.sin(t * Math.PI));
    let y = Math.sin(a) * 0.92;
    // Hundimientos en los polos.
    if (t > 0.88) y -= (t - 0.88) * 1.6;
    if (t < 0.1) y += (0.1 - t) * 1.2;
    r = Math.max(r, 0.001);
    pts.push([r, y]);
  }
  pts[0][0] = 0.001;
  pts[pts.length - 1][0] = 0.001;
  return lathe(pts);
}

const SPECS: Record<FruitKind, FruitSpec> = {
  watermelon: {
    shape: [1, 0.86, 0.86],
    skin: () => new THREE.MeshPhysicalMaterial({ map: watermelonTexture(), roughness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.4 }),
    flesh: () => new THREE.MeshStandardMaterial({ map: fleshTexture('watermelon', '#e53935', '#2e7d32'), roughness: 0.6 }),
    juice: '#ff4d6d',
  },
  apple: {
    shape: [1, 1, 1],
    skin: () =>
      new THREE.MeshPhysicalMaterial({ map: speckledTexture('apple', '#c62828', '#ffeb3b', 'rgba(255,200,60,0.35)'), roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.25 }),
    flesh: () => new THREE.MeshStandardMaterial({ map: fleshTexture('apple', '#fff3c4', '#c62828'), roughness: 0.7 }),
    juice: '#ffe9a8',
  },
  orange: {
    shape: [1, 0.97, 1],
    skin: () =>
      new THREE.MeshPhysicalMaterial({ map: speckledTexture('orange', '#fb8c00', '#ffb74d'), bumpMap: dimpleBump(), bumpScale: 0.6, roughness: 0.55, clearcoat: 0.3 }),
    flesh: () => new THREE.MeshStandardMaterial({ map: fleshTexture('citrus', '#ffa726', '#f57c00'), roughness: 0.5 }),
    juice: '#ffb300',
  },
  lemon: {
    shape: [0.82, 0.82, 1.18],
    skin: () =>
      new THREE.MeshPhysicalMaterial({ map: speckledTexture('lemon', '#fdd835', '#fff176'), bumpMap: dimpleBump(), bumpScale: 0.5, roughness: 0.45, clearcoat: 0.4 }),
    flesh: () => new THREE.MeshStandardMaterial({ map: fleshTexture('citrus', '#fff59d', '#fbc02d'), roughness: 0.5 }),
    juice: '#fff176',
  },
  peach: {
    shape: [1, 0.98, 0.95],
    skin: () =>
      new THREE.MeshPhysicalMaterial({
        map: speckledTexture('peach', '#ffab91', '#e57373', 'rgba(229,57,53,0.5)'),
        roughness: 0.75,
        sheen: 1,
        sheenColor: new THREE.Color('#ffe0d0'),
        sheenRoughness: 0.5,
      }),
    flesh: () => new THREE.MeshStandardMaterial({ map: fleshTexture('apple', '#ffcc80', '#ff8a65'), roughness: 0.6 }),
    juice: '#ffb199',
  },
};

export const fruitJuiceColor = (kind: FruitKind) => SPECS[kind].juice;

function stemAndLeaf(group: THREE.Group, top: number, leafColor = 0x43a047) {
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.05, 0.32, 8).translate(0, 0.16, 0),
    new THREE.MeshStandardMaterial({ color: 0x5d4037, roughness: 0.9 }),
  );
  stem.position.y = top - 0.06;
  stem.rotation.z = 0.25;
  const leafShape = new THREE.Shape();
  leafShape.moveTo(0, 0);
  leafShape.quadraticCurveTo(0.18, 0.12, 0.42, 0);
  leafShape.quadraticCurveTo(0.18, -0.12, 0, 0);
  const leaf = new THREE.Mesh(
    new THREE.ShapeGeometry(leafShape, 8),
    new THREE.MeshStandardMaterial({ color: leafColor, roughness: 0.6, side: THREE.DoubleSide }),
  );
  leaf.position.set(0.03, top + 0.12, 0);
  leaf.rotation.set(0.6, 0.3, 0.35);
  group.add(stem, leaf);
}

/** Fruta entera (radio 1, escalar con `group.scale.setScalar(radio)`). */
export function createFruit(kind: FruitKind): THREE.Group {
  const spec = SPECS[kind];
  const group = new THREE.Group();
  const geo = kind === 'apple' || kind === 'peach' ? appleGeometry() : new THREE.SphereGeometry(1, 40, 28);
  const body = new THREE.Mesh(geo, spec.skin());
  body.scale.set(...spec.shape);
  body.castShadow = true;
  group.add(body);
  if (kind === 'apple' || kind === 'peach') stemAndLeaf(group, 0.85, kind === 'peach' ? 0x558b2f : 0x43a047);
  if (kind === 'orange') {
    const navel = new THREE.Mesh(new THREE.CircleGeometry(0.07, 12), new THREE.MeshStandardMaterial({ color: 0x8d6e63 }));
    navel.position.y = 0.97;
    navel.rotation.x = -Math.PI / 2;
    group.add(navel);
  }
  if (kind === 'lemon') {
    for (const s of [-1, 1]) {
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), spec.skin());
      tip.position.z = s * 1.15;
      tip.scale.set(0.8, 0.8, 1);
      group.add(tip);
    }
  }
  return group;
}

/**
 * Mitad de una fruta cortada: cáscara (media esfera) + tapa con la pulpa a la vista.
 * `side` = +1 / -1 elige qué mitad (respecto al plano de corte local XY).
 */
export function createFruitHalf(kind: FruitKind, side: 1 | -1): THREE.Group {
  const spec = SPECS[kind];
  const group = new THREE.Group();
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, side > 0 ? 0 : Math.PI / 2, Math.PI / 2),
    spec.skin(),
  );
  shell.material.side = THREE.DoubleSide;
  shell.rotation.x = Math.PI / 2;
  const cap = new THREE.Mesh(new THREE.CircleGeometry(1, 40), spec.flesh());
  if (side < 0) cap.rotation.y = Math.PI;
  shell.castShadow = cap.castShadow = true;
  group.add(shell, cap);
  group.scale.set(...spec.shape);
  return group;
}
