import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const source = new URL('node_modules/@3d-dice/dice-box-threejs/public/', root);
const target = new URL('public/dice-assets/', root);
mkdirSync(target, { recursive: true });
cpSync(fileURLToPath(source), fileURLToPath(target), { recursive: true });
