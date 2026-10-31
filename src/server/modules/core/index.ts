import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import type { BotModule } from '../../runtime/types.js';
import { notice } from '../../render.js';
import { telemetry } from '../../telemetry.js';
let pulse: ReturnType<typeof setInterval> | undefined;

const module: BotModule = {
  id: 'core',
  title: 'Core',
  description: 'Подключение бота, жизненный цикл модулей и диагностика.',
  async start({ discord }) {
    await discord.start();
    clearInterval(pulse);
    const update = () => {
      telemetry.gatewayConnected.set(discord.isReady() ? 1 : 0);
      const ping = discord.client.ws.ping;
      if (Number.isFinite(ping) && ping >= 0) telemetry.gatewayLatency.set(ping / 1000);
    };
    update();
    pulse = setInterval(update, 10000);
    pulse.unref();
  },
  async stop({ discord }) {
    clearInterval(pulse);
    telemetry.gatewayConnected.set(0);
    await discord.stop();
  },
  commands: [
    {
      data: new SlashCommandBuilder().setName('ping').setDescription('Проверить задержку бота'),
      async execute({ interaction, ackMs }, { discord }) {
        const ws = discord.client.ws.ping;
        await interaction.editReply(
          notice(
            `## Pong!\nОтвет Discord: **${ackMs} мс**\nGateway: **${ws >= 0 ? Math.round(ws) + ' мс' : 'ожидание heartbeat'}**\nБот работает: **${Math.floor(process.uptime())} с**`,
          ),
        );
      },
    },
    {
      admin: true,
      data: new SlashCommandBuilder()
        .setName('status')
        .setDescription('Состояние модулей и процессов')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
      async execute({ interaction }, context) {
        const status = context.status();
        const rows = context.manager
          .list()
          .map(
            (module) =>
              `**${module.title}** — ${module.state}${module.errorId ? ' · ошибка ' + module.errorId : ''}`,
          );
        rows.push(
          `**Web** — ${status.web.state} · перезапусков: ${status.web.restarts}`,
          `Память Core: **${Math.round(process.memoryUsage().rss / 1024 / 1024)} МБ**`,
          `Процесс Core: **${process.pid}** · Web: **${status.web.pid || 'не запущен'}**`,
        );
        await interaction.editReply(notice('## Состояние Open Bot\n' + rows.join('\n')));
      },
    },
  ],
};
export default module;
