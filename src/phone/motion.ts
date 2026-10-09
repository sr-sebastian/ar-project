import { normalize3, type Vec3 } from '../core/math';

/**
 * Convierte `accelerationIncludingGravity` (coordenadas del dispositivo: x derecha, y hacia
 * arriba del teléfono, z saliendo de la pantalla) en el vector "arriba" en coordenadas de
 * la cámara (x derecha, y abajo, z hacia donde mira la cámara).
 *
 * En reposo el acelerómetro mide la reacción a la gravedad, o sea apunta hacia arriba.
 * @param screenAngle rotación de la pantalla (screen.orientation.angle), en grados.
 * @param facing 'environment' = cámara trasera, 'user' = frontal.
 */
export function deviceUpToCamera(acc: Vec3, screenAngle: number, facing: 'environment' | 'user'): Vec3 {
  const a = (screenAngle * Math.PI) / 180;
  // Primero a ejes de la imagen (la imagen rota con la pantalla).
  const sx = acc.x * Math.cos(a) - acc.y * Math.sin(a);
  const sy = acc.x * Math.sin(a) + acc.y * Math.cos(a);
  // Imagen: y hacia abajo. Trasera: la cámara mira hacia -z del dispositivo; frontal hacia +z.
  const cam = facing === 'environment' ? { x: sx, y: -sy, z: -acc.z } : { x: -sx, y: -sy, z: acc.z };
  return normalize3(cam);
}
