#!/usr/bin/env bash
# Hook "Stop" de Claude Code: cuando Claude termina un turno, verifica el proyecto,
# commitea lo pendiente y lo sube a la rama main de origin.
#
# - Si no hay cambios ni commits sin subir, no hace nada.
# - Si fallan los checks, no sube nada y le pide a Claude que lo arregle (una sola vez
#   por turno, gracias a stop_hook_active, para no entrar en un bucle).
# - Nunca hace force push: integra origin/main con merge.
#
# Para desactivarlo sin borrar el hook: AR_AUTO_PUSH=0
set -uo pipefail

input=$(cat || true)
stop_hook_active=$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null || echo false)

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" || exit 0

say() { jq -n --arg m "$1" '{systemMessage: $m}'; }
block() { jq -n --arg r "$1" '{decision: "block", reason: $r}'; }

[ "${AR_AUTO_PUSH:-1}" = "0" ] && exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

git fetch -q origin main 2>/dev/null
has_remote_main=$(git rev-parse -q --verify origin/main >/dev/null && echo 1 || echo 0)
dirty=$([ -n "$(git status --porcelain)" ] && echo 1 || echo 0)
ahead=0
if [ "$has_remote_main" = 1 ]; then
  [ "$(git rev-list --count origin/main..HEAD)" -gt 0 ] && ahead=1
else
  ahead=1
fi

# Nada nuevo: salir en silencio.
[ "$dirty" = 0 ] && [ "$ahead" = 0 ] && exit 0

# 1. Verificar.
[ -d node_modules ] || npm install --silent >/dev/null 2>&1
log=$(mktemp)
for step in lint typecheck test build; do
  if ! npm run --silent "$step" >"$log" 2>&1; then
    tail_out=$(tail -n 30 "$log")
    rm -f "$log"
    if [ "$stop_hook_active" = "true" ]; then
      say "⛔ Auto-push a main cancelado: falló 'npm run $step'."
    else
      block "Auto-push a main cancelado: falló 'npm run $step'. Arreglalo antes de terminar.
$tail_out"
    fi
    exit 0
  fi
done
rm -f "$log"

# 2. Commitear lo pendiente.
if [ "$dirty" = 1 ]; then
  git add -A
  files=$(git diff --cached --name-only | head -n 8 | paste -sd ', ' -)
  count=$(git diff --cached --name-only | wc -l | tr -d ' ')
  git commit -q -m "Auto: actualizar $count archivo(s)" -m "$files" || { say "⛔ Auto-push: no se pudo commitear."; exit 0; }
fi

# 3. Integrar main remoto (sin reescribir historia).
if [ "$has_remote_main" = 1 ] && ! git merge-base --is-ancestor origin/main HEAD; then
  if ! git merge -q --no-edit origin/main >/dev/null 2>&1; then
    git merge --abort 2>/dev/null
    say "⛔ Auto-push: conflicto al integrar origin/main. Resolvelo a mano y volvé a intentar."
    exit 0
  fi
fi

# 4. Push (con reintentos ante errores de red).
pushed=0
for wait in 0 2 4 8 16; do
  sleep "$wait"
  if git push -q origin HEAD:main 2>/dev/null; then pushed=1; break; fi
done
if [ "$pushed" = 0 ]; then
  say "⛔ Auto-push: falló 'git push origin HEAD:main'."
  exit 0
fi

branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" != "main" ] && [ "$branch" != "HEAD" ] && git push -q -u origin HEAD 2>/dev/null

say "✅ Subido a main: $(git log -1 --format='%h %s')"
