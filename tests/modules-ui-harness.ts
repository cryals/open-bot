// Isolated demo: all Discord operations and Watchdog actions terminate in local fakes.
import { createServer } from 'node:http';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { loadSeed } from '../src/server/seed.js';
import { ActivityService } from '../src/server/activity.js';
import { TicketService } from '../src/server/modules/ticket/service.js';
import { ServerStatusService } from '../src/server/modules/game-server-status/service.js';
import { WatchdogService } from '../src/server/modules/watchdog/service.js';
import { ModuleDiscord, ticketSettings, AUTHOR, VIEWER, MANAGER, SUPPORT } from './module-fixtures.js';
import { initialTicketConfig } from '../src/shared/modules.js';
import { testConfig } from './fixtures.js';
const port = Number(process.env.UI_PORT || 3320),
  mockPort = port + 1;
const store = new Store(':memory:', testConfig.guildId, loadSeed());
const discord = new ModuleDiscord(),
  config = {
    ...testConfig,
    port,
    origin: `http://localhost:${port}`,
    appOrigin: `http://localhost:${port}`,
    redirect: new URL(`http://localhost:${port}/auth/discord/callback`),
    ticketEnabled: true,
    gameServerHosts: ['127.0.0.1'],
    watchdogHosts: ['127.0.0.1'],
  };
const activity = new ActivityService(store, discord, [], { deliver: false });
// UI demo metadata for the new live permission diagnostics. No Gateway or real Discord credentials.
const demoGet = discord.rest.get.bind(discord.rest),
  demoRole = '195000000000000001';
discord.rest.get = async (route, options) => {
  if (route === `/guilds/${config.guildId}`)
    return { id: config.guildId, owner_id: AUTHOR, name: 'Демонстрационный сервер' };
  if (route === `/guilds/${config.guildId}/roles`)
    return [
      { id: config.guildId, name: 'everyone', permissions: '0', position: 0 },
      { id: demoRole, name: 'Open Bot', permissions: '8', position: 100 },
      ...[SUPPORT, initialTicketConfig.fullRoleId, initialTicketConfig.viewRoleId].map((id) => ({
        id,
        name: id,
        permissions: '0',
        position: 1,
        managed: false,
      })),
    ];
  if (route.startsWith(`/guilds/${config.guildId}/members/`)) {
    const id = route.split('/').at(-1)!;
    return {
      user: { id, username: 'Демо' },
      roles:
        id === config.clientId
          ? [demoRole]
          : id === AUTHOR
            ? []
            : id === MANAGER
              ? [initialTicketConfig.fullRoleId]
              : [initialTicketConfig.viewRoleId],
    };
  }
  return demoGet(route, options);
};
const tickets = new TicketService(config, store, discord, activity);
await tickets.saveConfig(ticketSettings, 0, { userId: AUTHOR, name: 'Администратор' });
for (const [author, text] of [
  [VIEWER, 'Не могу подключиться к серверу. Подскажите, где взять лаунчер?'],
  [MANAGER, 'Хочу уточнить правила игры.'],
  [AUTHOR, 'Проверка личного обращения администратора.'],
]) {
  const ticket = tickets.reserve(author, 'question');
  for (let i = 0; i < 4; i++) await tickets.tick();
  const row = tickets.tickets.get(ticket.id);
  await tickets.archive.capture(ticket.id, 'customer', {
    id: String(++discord.serial),
    author: { id: author, username: 'Участник' } as never,
    content: text,
    timestamp: new Date().toISOString(),
  });
  await tickets.archive.capture(ticket.id, 'customer', {
    id: String(++discord.serial),
    author: { id: MANAGER, username: 'Поддержка' } as never,
    content: 'Здравствуйте! Опишите, что происходит при запуске.',
    timestamp: new Date().toISOString(),
  });
  await tickets.archive.capture(ticket.id, 'staff', {
    id: String(++discord.serial),
    author: { id: MANAGER, username: 'Поддержка' } as never,
    content: 'Внутреннее обсуждение команды. Автор обращения это сообщение не видит.',
    timestamp: new Date().toISOString(),
  });
  if (author === MANAGER) await tickets.change(row.id, { userId: AUTHOR, name: 'Администратор' }, 'claim');
}
const mock = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/status') {
    response.end(
      JSON.stringify({
        name: 'Демонстрационный SS14',
        players: 42,
        soft_max_players: 100,
        run_level: 1,
        map: 'Gemini',
        preset: 'Secret',
        round_id: 40385,
        round_start_time: new Date(Date.now() - 3540000).toISOString(),
      }),
    );
    return;
  }
  if (request.method === 'GET') {
    response.end(
      JSON.stringify([
        { version: 'a1b2c3d4e5', current: true, time: '2026-10-30' },
        { version: 'f6e7d8c9b0', current: false, time: '2026-10-29' },
      ]),
    );
    return;
  }
  response.end(JSON.stringify({ accepted: true, simulated: true }));
});
await new Promise<void>((resolve) => mock.listen(mockPort, '127.0.0.1', resolve));
new ServerStatusService(config, store, discord).save(
  { servers: [{ id: 'demo', name: 'Демонстрационный SS14', address: `ss14://127.0.0.1:${mockPort}` }] },
  0,
);
process.env.WATCHDOG_TOKEN_DEMO = 'local-fake-token-not-a-real-credential';
new WatchdogService(config, store, activity).save(
  {
    servers: [
      {
        id: 'demo',
        name: 'Локальный Watchdog',
        address: `http://127.0.0.1:${mockPort}`,
        instance: 'main',
        tokenEnv: 'WATCHDOG_TOKEN_DEMO',
      },
    ],
  },
  0,
);
const app = await createApp({
  config,
  store,
  discord,
  activity,
  oauth: { exchange: async () => ({ id: AUTHOR, name: 'Администратор' }) },
  logger: false,
});
app.get('/__demo/:role', async (request, reply) => {
  const role = (request.params as { role: string }).role;
  const user =
    role === 'viewer'
      ? { id: VIEWER, name: 'Архивариус' }
      : role === 'manager'
        ? { id: MANAGER, name: 'Куратор тикетов' }
        : { id: AUTHOR, name: 'Администратор' };
  const session = store.createSession(user);
  reply.setCookie('os_session', session.token, { httpOnly: true, sameSite: 'lax', secure: false, path: '/' });
  return reply.redirect('/');
});
const timer = setInterval(() => void tickets.tick(), 2000);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await app.close();
  mock.closeAllConnections();
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  await activity.close();
  store.close();
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
await app.listen({ port, host: '127.0.0.1' });
console.log(
  `Module demo: http://localhost:${port}/__demo/admin (or /viewer, /manager); mock server ${mockPort}`,
);
