import { loadConfig } from './config.js';
import { supervise } from './runtime/supervisor.js';

try {
  await supervise(loadConfig());
} catch (error) {
  // Configuration/instance errors contain variable names or process IDs, never environment values.
  console.error(error instanceof Error ? error.message : 'Supervisor startup failed');
  process.exitCode = 1;
}
