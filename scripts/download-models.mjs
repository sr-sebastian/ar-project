// Descarga los modelos de MediaPipe a public/models para trabajar sin depender de la red.
// Uso: npm run models:download
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODELS = {
  'pose_landmarker_lite.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
  'pose_landmarker_full.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
  'pose_landmarker_heavy.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task',
  'gesture_recognizer.task':
    'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task',
  'face_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task',
};

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models');
await mkdir(outDir, { recursive: true });

for (const [name, url] of Object.entries(MODELS)) {
  const target = join(outDir, name);
  if (await stat(target).then(() => true, () => false)) {
    console.log(`✓ ${name} (ya existe)`);
    continue;
  }
  process.stdout.write(`↓ ${name} … `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await writeFile(target, Buffer.from(await res.arrayBuffer()));
  console.log('ok');
}
