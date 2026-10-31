import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as tcpServer, type AddressInfo } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { serverSchema, watchdogServerSchema } from '../src/shared/modules.js';
import { queryGame, gameEndpoint } from '../src/server/modules/game-server-status/protocols.js';
import { ServerStatusService } from '../src/server/modules/game-server-status/service.js';
import { monitorSummary } from '../src/server/modules/game-server-status/state.js';
import { MetricsExporter } from '../src/server/modules/metrics/exporter.js';
import { Store } from '../src/server/store.js';
import { loadSeed } from '../src/server/seed.js';
import { FakeDiscord, testConfig } from './fixtures.js';

test('Legacy SS14 config defaults and Watchdog identity remain compatible', () => {
  assert.equal(serverSchema.parse({ id: 'one', name: 'One', address: 'ss14s://example.org' }).game, 'ss14');
  const watchdog = watchdogServerSchema.parse({
    id: 'one',
    name: 'One',
    address: 'http://example.org',
    instance: 'main',
    tokenEnv: 'WATCHDOG_TOKEN_TEST',
  });
  assert.ok(!('game' in watchdog));
});
test('Game endpoints validate host, port, protocol and credentials before networking', () => {
  const hosts = ['example.org'];
  const endpoint = (game: string, address: string) =>
    gameEndpoint(serverSchema.parse({ id: 'one', name: 'One', game, address }), hosts);
  assert.equal(endpoint('minecraft', 'minecraft://example.org').port, '25565');
  assert.equal(endpoint('minecraft', 'bedrock://example.org').port, '19132');
  assert.equal(endpoint('ss13', 'byond://example.org:1337').port, '1337');
  assert.equal(endpoint('project-zomboid', 'udp://example.org:16261').port, '16261');
  assert.throws(() => endpoint('minecraft', 'minecraft://private.example:25565'), /не разрешён/);
  assert.throws(() => endpoint('ss13', 'byond://example.org'), /порт/);
  assert.throws(() => endpoint('minecraft', 'http://example.org'), /Протокол/);
  assert.throws(() => endpoint('terraria', 'https://secret@example.org'), /пароль/);
  assert.throws(() => endpoint('terraria', 'https://example.org?token=secret'), /токен|пароль/);
});
test('TShock status normalizes counts and keeps REST token out of projections', async () => {
  process.env.GAME_SERVER_TOKEN_LOCAL = 'local-fake-status-token';
  const server = httpServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    assert.equal(url.pathname, '/v2/server/status');
    assert.equal(url.searchParams.get('token'), process.env.GAME_SERVER_TOKEN_LOCAL);
    response.end(
      JSON.stringify({
        status: '200',
        name: 'Terraria local',
        world: 'Test world',
        playercount: 2,
        maxplayers: 16,
        serverversion: '1.4',
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await queryGame(
      serverSchema.parse({
        id: 'terra',
        name: 'Local',
        game: 'terraria',
        address: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        tokenEnv: 'GAME_SERVER_TOKEN_LOCAL',
      }),
      ['127.0.0.1'],
    );
    assert.equal(result.players, '2/16');
    assert.equal(result.map, 'Test world');
    assert.ok(!JSON.stringify(result).includes('local-fake-status-token'));
  } finally {
    delete process.env.GAME_SERVER_TOKEN_LOCAL;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('SS13 reads fragmented BYOND frames and only requests public status', async () => {
  const server = tcpServer((socket) =>
    socket.once('data', (request) => {
      assert.equal(request.readUInt16BE(0), 131);
      assert.equal(request.subarray(9).toString(), '?status\0');
      const payload = Buffer.from(
        '\x06name=SS13+Local&players=7&popcap=40&map_name=Box&mode=extended&round_id=19\0',
      );
      const header = Buffer.from([0, 131, 0, 0]);
      header.writeUInt16BE(payload.length, 2);
      socket.write(header.subarray(0, 2));
      setTimeout(() => socket.end(Buffer.concat([header.subarray(2), payload])), 5);
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await queryGame(
      serverSchema.parse({
        id: 'ss13',
        name: 'Local',
        game: 'ss13',
        address: `byond://127.0.0.1:${(server.address() as AddressInfo).port}`,
      }),
      ['127.0.0.1'],
    );
    assert.equal(result.players, '7/40');
    assert.equal(result.map, 'Box');
    assert.equal(result.roundId, '19');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
const variableInteger = (value: number) => {
  const bytes: number[] = [];
  do {
    let byte = value & 127;
    value >>>= 7;
    if (value) byte |= 128;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
};
test('Minecraft Bedrock uses its UDP status protocol', async () => {
  const socket = createSocket('udp4');
  socket.on('message', (request, remote) => {
    assert.equal(request[0], 1);
    const text = Buffer.from('MCPE;Local Bedrock;776;1.21.60;2;12;12345;World;Survival;1;19132;19133;');
    const length = Buffer.alloc(2);
    length.writeUInt16BE(text.length);
    socket.send(
      Buffer.concat([
        Buffer.from([28]),
        request.subarray(1, 9),
        Buffer.alloc(8),
        Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex'),
        length,
        text,
      ]),
      remote.port,
      remote.address,
    );
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  try {
    const status = await queryGame(
      serverSchema.parse({
        id: 'bedrock',
        name: 'Bedrock',
        game: 'minecraft',
        address: `bedrock://127.0.0.1:${(socket.address() as AddressInfo).port}`,
      }),
      ['127.0.0.1'],
    );
    assert.equal(status.players, '2/12');
    assert.equal(status.version, '1.21.60');
    assert.equal(status.preset, 'Bedrock');
  } finally {
    socket.close();
  }
});
test('Minecraft Java uses the status protocol without joining a game', async () => {
  const server = tcpServer((socket) =>
    socket.once('data', () => {
      const json = Buffer.from(
        JSON.stringify({
          version: { name: '1.21', protocol: 767 },
          players: { online: 3, max: 20 },
          description: { text: 'Local Minecraft' },
        }),
      );
      const payload = Buffer.concat([Buffer.from([0]), variableInteger(json.length), json]);
      socket.end(Buffer.concat([variableInteger(payload.length), payload]));
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await queryGame(
      serverSchema.parse({
        id: 'mc',
        name: 'Local',
        game: 'minecraft',
        address: `minecraft://127.0.0.1:${(server.address() as AddressInfo).port}`,
      }),
      ['127.0.0.1'],
    );
    assert.equal(result.players, '3/20');
    assert.equal(result.preset, 'Java');
    assert.equal(result.version, '1.21');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('Project Zomboid uses the configured A2S query port', async () => {
  const socket = createSocket('udp4');
  socket.on('message', (_request, remote) => {
    const str = (value: string) => Buffer.from(value + '\0');
    const body = Buffer.concat([
      Buffer.from([255, 255, 255, 255, 73, 17]),
      str('Local Zomboid'),
      str('Muldraugh'),
      str('zomboid'),
      str('Project Zomboid'),
      Buffer.from([0, 0, 4, 32, 0, 100, 108, 0, 0]),
      str('42.0'),
    ]);
    socket.send(body, remote.port, remote.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  try {
    const result = await queryGame(
      serverSchema.parse({
        id: 'pz',
        name: 'Local',
        game: 'project-zomboid',
        address: `udp://127.0.0.1:${(socket.address() as AddressInfo).port}`,
      }),
      ['127.0.0.1'],
    );
    assert.equal(result.players, '4/32');
    assert.equal(result.map, 'Muldraugh');
  } finally {
    socket.close();
  }
});
test('Monitoring persists probes, shares cache and exports stale data as unknown without IDs', async () => {
  let calls = 0;
  const server = httpServer((_request, response) => {
    calls++;
    response.end(
      JSON.stringify({ name: 'Private server name', players: 5, soft_max_players: 30, run_level: 1 }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const store = new Store(':memory:', testConfig.guildId, loadSeed()),
    config = { ...testConfig, gameServerHosts: ['127.0.0.1'] },
    discord = new FakeDiscord();
  try {
    const service = new ServerStatusService(config, store, discord);
    service.save(
      {
        servers: [
          {
            id: 'secret-server-id',
            name: 'Private server name',
            address: `ss14://127.0.0.1:${(server.address() as AddressInfo).port}`,
          },
        ],
      },
      0,
    );
    await service.tick();
    assert.equal(calls, 1);
    await new ServerStatusService(config, store, discord).get('secret-server-id');
    assert.equal(calls, 1);
    let metrics = await new MetricsExporter(config, store).collect();
    assert.match(metrics, /open_bot_game_players\{game="ss14"\} 5/);
    assert.ok(!metrics.includes('secret-server-id'));
    assert.ok(!metrics.includes('Private server name'));
    store.sqlite.prepare('UPDATE server_monitor_samples SET updated_at=?').run(Date.now() - 180000);
    assert.equal(monitorSummary(store).find((row) => row.game === 'ss14')?.unknown, 1);
    metrics = await new MetricsExporter(config, store).collect();
    assert.match(metrics, /open_bot_game_servers\{game="ss14",state="unknown"\} 1/);
  } finally {
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
