import type { ModuleSource } from '../runtime/types.js';
/** Register one loader here. Help and slash-command registration consume the same module definitions. */
export const botModules: ModuleSource[] = [
  { id: 'core', load: () => import('./core/index.js') },
  { id: 'help', load: () => import('./help/index.js') },
  { id: 'info', load: () => import('./info/index.js') },
];
