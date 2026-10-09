import type { ModeId } from '../core/modes';
import { debugApp } from './debug/DebugApp';
import { fruitSlicerApp } from './fruit-slicer/FruitSlicerApp';
import type { AppDefinition } from './types';
import { whackAMoleApp } from './whack-a-mole/WhackAMoleApp';

/**
 * Todas las apps (minijuegos y utilidades). Para agregar una nueva: crear su carpeta en
 * `src/apps/`, exportar un `AppDefinition` y sumarlo acá indicando sus modos.
 */
export const APPS: AppDefinition[] = [fruitSlicerApp, whackAMoleApp, debugApp];

export const appsForMode = (mode: ModeId) => APPS.filter((a) => a.modes.includes(mode));
