import type { ModuleSource } from '../runtime/types.js';
/** Register one loader here. Help and slash-command registration consume the same module definitions. */
export const botModules: ModuleSource[] = [
  { id: 'core', load: () => import('./core/index.js') },
  { id: 'help', load: () => import('./help/index.js') },
  { id: 'info', load: () => import('./info/index.js') },
  { id: 'ticket', load: () => import('./ticket/index.js') },
  { id: 'metrics', load: () => import('./metrics/index.js') },
  { id: 'game-server-status', load: () => import('./game-server-status/index.js') },
  { id: 'watchdog', load: () => import('./watchdog/index.js') },
];
