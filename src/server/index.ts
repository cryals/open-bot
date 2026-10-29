import { loadConfig } from './config.js';
import { Store } from './store.js';
import { loadSeed } from './seed.js';
import { DiscordService } from './discord.js';
import { DiscordOAuth } from './oauth.js';
import { createApp } from './app.js';

const config = loadConfig();
const store = new Store(config.databasePath, config.guildId, loadSeed(), config.adminRoleId);
const discord = new DiscordService(config, store, (error) => {
  console.error(
    'Discord error:',
    error instanceof Error ? error.name + ': ' + error.message : 'Unknown error',
  );
});
const app = await createApp({ config, store, discord, oauth: new DiscordOAuth(config) });
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await discord.stop();
  store.close();
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
try {
  await Promise.all([app.listen({ port: config.port, host: config.host }), discord.start()]);
  app.log.info('Open Space bot connected. Rules are published through the web panel.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  await shutdown();
  process.exitCode = 1;
}
