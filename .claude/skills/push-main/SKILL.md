---
name: push-main
description: Verifica el proyecto (lint, typecheck, tests, build), commitea los cambios pendientes y los sube a la rama main de origin. Usar cuando el usuario pida "subir a main", "push a main", "publicar los cambios" o invoque /push-main.
---

# Subir a main

Invocar esta skill es la autorización del usuario para pushear a `main`; no hace falta volver a preguntar. Seguí los pasos en orden y frená ante el primer error.

## 1. Verificar

Corré los checks del repo. Si alguno falla, **no pushees**: arreglá el problema si es claramente parte del trabajo actual, o mostrale al usuario la salida del error y pará.

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

Si falta `node_modules`, corré antes `npm install`.

## 2. Commitear lo pendiente

```bash
git status --short
```

- Si hay cambios, revisá el diff (`git diff`, `git diff --cached`) y descartá del commit cualquier cosa que no deba subirse: secretos, `.env`, `dist/`, `public/models/`, archivos temporales. Commiteá con `git add -A` (el `.gitignore` ya excluye lo generado) y un mensaje en español que resuma los cambios, terminando con las líneas de atribución que indique la sesión.
- Si no hay cambios y no hay commits sin subir, avisá que no hay nada para subir y terminá.

## 3. Integrar con main remoto

```bash
git fetch origin main
```

- Si `origin/main` no existe todavía, saltá al paso 4 (el push la crea).
- Si existe, integrala en la rama actual con `git merge origin/main` (nunca rebase ni reescribir historia). Si hay conflictos que no se resuelven sin perder comportamiento, pará y preguntale al usuario.
- Si el merge trajo cambios, repetí el paso 1 antes de seguir.

## 4. Push

Desde la rama actual (sea `main` o una rama de trabajo):

```bash
git push origin HEAD:main
```

- **Nunca** uses `--force` ni `--force-with-lease` contra `main`. Si el push es rechazado por no ser fast-forward, volvé al paso 3.
- Si falla por red, reintentá hasta 4 veces esperando 2 s, 4 s, 8 s y 16 s.
- Si estás en una rama de trabajo, subila también para mantenerla sincronizada: `git push -u origin HEAD`.

## 5. Confirmar

```bash
git ls-remote --heads origin main
```

Informale al usuario en una o dos líneas: el commit (hash corto + mensaje) que quedó en `main` y el resultado de los checks.
