import type * as THREE from 'three';

/**
 * Modelos propios opcionales: si existe `public/models3d/<nombre>.glb`, se usa ese modelo
 * en lugar del procedural (por ejemplo `katana.glb`, `mole.glb`). Se cargan una vez y se
 * clonan por instancia. Si no existen, las apps siguen usando los procedurales.
 */
const loaded = new Map<string, THREE.Object3D | null>();
const pending = new Map<string, Promise<THREE.Object3D | null>>();

export function preloadModel(name: string): Promise<THREE.Object3D | null> {
  if (loaded.has(name)) return Promise.resolve(loaded.get(name)!);
  const existing = pending.get(name);
  if (existing) return existing;
  const url = `${import.meta.env.BASE_URL}models3d/${name}.glb`;
  const p = (async () => {
    try {
      const head = await fetch(url, { method: 'HEAD' });
      const type = head.headers.get('content-type') ?? '';
      if (!head.ok || type.includes('text/html')) return null;
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const gltf = await new GLTFLoader().loadAsync(url);
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.castShadow = mesh.receiveShadow = true;
      });
      return gltf.scene;
    } catch (err) {
      console.warn(`[models] no se pudo cargar ${url}`, err);
      return null;
    }
  })().then((obj) => {
    loaded.set(name, obj);
    pending.delete(name);
    return obj;
  });
  pending.set(name, p);
  return p;
}

/** Clon del modelo propio si ya se cargó; si no, `null` (usar el procedural). */
export function customModel(name: string): THREE.Object3D | null {
  return loaded.get(name)?.clone(true) ?? null;
}
