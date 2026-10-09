import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { bladeTexture, blockFaceTexture, furTexture, grassTexture, handleWrapTexture, woodTexture } from './textures';

/** Bomba de dibujo animado (radio 1): esfera metálica, boquilla, mecha y chispa. */
export function createBomb(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(1, 40, 28),
    new THREE.MeshPhysicalMaterial({ color: 0x1c1f24, metalness: 0.6, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.15 }),
  );
  body.castShadow = true;
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.28, 0.34, 0.26, 24),
    new THREE.MeshStandardMaterial({ color: 0x8a8f98, metalness: 0.9, roughness: 0.3 }),
  );
  cap.position.y = 1.0;
  const fuseCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 1.1, 0),
    new THREE.Vector3(0.1, 1.35, 0.05),
    new THREE.Vector3(0.3, 1.5, -0.05),
    new THREE.Vector3(0.45, 1.55, 0),
  ]);
  const fuse = new THREE.Mesh(new THREE.TubeGeometry(fuseCurve, 20, 0.05, 8), new THREE.MeshStandardMaterial({ color: 0xc8a165, roughness: 0.9 }));
  const spark = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd54f }));
  spark.position.set(0.45, 1.55, 0);
  spark.name = 'spark';
  const glow = new THREE.PointLight(0xff8a00, 0.6, 3);
  glow.position.copy(spark.position);
  g.add(body, cap, fuse, spark, glow);
  return g;
}

/**
 * Katana (medidas reales, ~1 m). Origen en el centro de la empuñadura; la hoja apunta a +Y
 * con el filo hacia +X. `bladeTip` y `bladeBase` (locales) sirven para detectar cortes.
 */
export function createKatana(): { group: THREE.Group; bladeBase: THREE.Vector3; bladeTip: THREE.Vector3 } {
  const g = new THREE.Group();
  const handleLen = 0.26;
  const bladeLen = 0.72;

  // Hoja: perfil curvo (sori) extruido muy fino, con punta (kissaki).
  const shape = new THREE.Shape();
  const width = 0.032;
  const curve = (y: number) => 0.02 * (y / bladeLen) ** 2; // curvatura hacia el lomo
  shape.moveTo(0, 0);
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const y = (i / steps) * (bladeLen - 0.05);
    shape.lineTo(width / 2 - curve(y), y);
  }
  shape.lineTo(-curve(bladeLen) - 0.004, bladeLen); // punta
  for (let i = steps; i >= 0; i--) {
    const y = (i / steps) * (bladeLen - 0.05);
    shape.lineTo(-width / 2 - curve(y), y);
  }
  shape.closePath();
  const bladeGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.004, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.003, bevelSegments: 2 });
  bladeGeo.translate(0, 0, -0.002);
  // UV simples: x a lo ancho, y a lo largo.
  const uv = bladeGeo.attributes.uv as THREE.BufferAttribute;
  const pos = bladeGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (pos.getX(i) + width) / (2 * width), pos.getY(i) / bladeLen);
  const blade = new THREE.Mesh(
    bladeGeo,
    new THREE.MeshPhysicalMaterial({ map: bladeTexture(), metalness: 1, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05 }),
  );
  blade.position.y = handleLen / 2 + 0.012;
  blade.castShadow = true;

  // Habaki (collar dorado) y tsuba (guarda).
  const habaki = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.03, 0.012), new THREE.MeshStandardMaterial({ color: 0xc9a227, metalness: 1, roughness: 0.25 }));
  habaki.position.y = handleLen / 2 + 0.015;
  const tsuba = new THREE.Mesh(
    new THREE.CylinderGeometry(0.042, 0.042, 0.008, 32).scale(1, 1, 0.8),
    new THREE.MeshStandardMaterial({ color: 0x2b2b2b, metalness: 0.85, roughness: 0.35 }),
  );
  tsuba.position.y = handleLen / 2;

  // Tsuka (mango) con encordado y kashira (pomo).
  const handleTex = handleWrapTexture();
  handleTex.repeat.set(1, 3);
  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.016, 0.018, handleLen, 24, 1, false).scale(1, 1, 0.75),
    new THREE.MeshStandardMaterial({ map: handleTex, roughness: 0.8 }),
  );
  handle.castShadow = true;
  const kashira = new THREE.Mesh(new THREE.SphereGeometry(0.019, 16, 8).scale(1, 0.6, 0.75), new THREE.MeshStandardMaterial({ color: 0x2b2b2b, metalness: 0.8, roughness: 0.3 }));
  kashira.position.y = -handleLen / 2;

  g.add(blade, habaki, tsuba, handle, kashira);
  return {
    group: g,
    bladeBase: new THREE.Vector3(0, handleLen / 2 + 0.03, 0),
    bladeTip: new THREE.Vector3(0, handleLen / 2 + bladeLen, 0),
  };
}

/**
 * Topo (altura total ≈ 1, base en y=0) con pelaje, panza, ojos con brillo, nariz,
 * dientes, bigotes y manitos.
 */
export function createMole(): THREE.Group {
  const g = new THREE.Group();
  const furMat = new THREE.MeshStandardMaterial({ map: furTexture('#7b5233'), roughness: 0.95, color: 0xffffff });
  const profile: THREE.Vector2[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const y = t * 1;
    const r = 0.36 * Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(0, t - 0.55) / 0.45, 2))) * (t < 0.55 ? 1 : 1);
    profile.push(new THREE.Vector2(Math.max(r, 0.001), y));
  }
  const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 32), furMat);
  body.castShadow = true;
  body.name = 'body';
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.26, 24, 16), new THREE.MeshStandardMaterial({ color: 0xd7b48f, roughness: 0.9 }));
  belly.scale.set(1, 1.3, 0.5);
  belly.position.set(0, 0.42, 0.2);

  const eyeWhite = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2 });
  const pupilMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.1 });
  const shine = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), eyeWhite);
    eye.position.set(s * 0.12, 0.8, 0.25);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), pupilMat);
    pupil.position.set(s * 0.12, 0.8, 0.31);
    const spark = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 6), shine);
    spark.position.set(s * 0.12 + 0.015, 0.82, 0.35);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), new THREE.MeshStandardMaterial({ color: 0xf0a3a3, roughness: 0.7 }));
    hand.scale.set(1.2, 0.6, 0.8);
    hand.position.set(s * 0.22, 0.52, 0.27);
    g.add(eye, pupil, spark, hand);
    for (const k of [-1, 1]) {
      const whisker = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.22, 4), new THREE.MeshBasicMaterial({ color: 0x222222 }));
      whisker.rotation.z = Math.PI / 2 + k * 0.15;
      whisker.position.set(s * 0.15, 0.66 + k * 0.025, 0.31);
      g.add(whisker);
    }
  }
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), new THREE.MeshPhysicalMaterial({ color: 0xff7aa2, roughness: 0.25, clearcoat: 1 }));
  nose.position.set(0, 0.68, 0.35);
  nose.scale.set(1.2, 0.9, 1);
  const teeth = new THREE.Mesh(new RoundedBoxGeometry(0.08, 0.06, 0.02, 2, 0.008), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }));
  teeth.position.set(0, 0.58, 0.33);
  g.add(body, belly, nose, teeth);
  return g;
}

export const BLOCK_COLORS = ['#ef5350', '#42a5f5', '#66bb6a', '#ffca28', '#ab47bc', '#26c6da', '#ff7043'];

/** Bloque de juguete con bordes redondeados y letras en las caras. Medidas en metros. */
export function createToyBlock(size: THREE.Vector3, color: string, glyph: string): THREE.Mesh {
  const r = Math.min(size.x, size.y, size.z) * 0.08;
  const geo = new RoundedBoxGeometry(size.x, size.y, size.z, 3, r);
  const face = new THREE.MeshPhysicalMaterial({ map: blockFaceTexture(color, glyph), roughness: 0.45, clearcoat: 0.6, clearcoatRoughness: 0.3 });
  const mesh = new THREE.Mesh(geo, face);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Bloque de madera (vetas), para variar. */
export function createWoodBlock(size: THREE.Vector3, tint = '#c8955a'): THREE.Mesh {
  const r = Math.min(size.x, size.y, size.z) * 0.06;
  const tex = woodTexture(tint);
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(size.x, size.y, size.z, 3, r), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Tablero de topos: base de madera con pasto, agujeros con interior oscuro (tubos) para
 * que los topos parezcan salir de adentro. Medidas en metros; origen en la superficie.
 */
export function createMoleBoard(width: number, depth: number, holes: THREE.Vector3[], holeRadius: number): THREE.Group {
  const g = new THREE.Group();
  const thickness = 0.02;
  const base = new THREE.Mesh(new RoundedBoxGeometry(width, thickness, depth, 3, 0.008), new THREE.MeshStandardMaterial({ map: woodTexture('#a1683a'), roughness: 0.75 }));
  base.position.y = thickness / 2;
  base.castShadow = true;
  base.receiveShadow = true;
  const grassTex = grassTexture();
  grassTex.repeat.set(3, 3);
  const top = new THREE.Mesh(new THREE.PlaneGeometry(width * 0.92, depth * 0.92).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 }));
  top.position.y = thickness + 0.0008;
  top.receiveShadow = true;
  g.add(base, top);
  for (const h of holes) {
    // Borde de tierra + agujero negro con tubo interior.
    const rim = new THREE.Mesh(new THREE.TorusGeometry(holeRadius * 1.05, holeRadius * 0.18, 10, 32).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x6d4c2f, roughness: 1 }));
    rim.position.set(h.x, thickness + 0.003, h.z);
    rim.castShadow = true;
    const hole = new THREE.Mesh(new THREE.CircleGeometry(holeRadius, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x0b0704 }));
    hole.position.set(h.x, thickness + 0.0015, h.z);
    g.add(rim, hole);
  }
  return g;
}
