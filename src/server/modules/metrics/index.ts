import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import type { BotModule } from '../../runtime/types.js';
import { notice } from '../../render.js';
const module: BotModule = {
  id: 'metrics',
  title: 'Metrics',
  description: 'Метрики процессов, команд, HTTP и тикетов для Prometheus/Grafana.',
  dependencies: ['core'],
  commands: [
    {
      admin: true,
      data: new SlashCommandBuilder()
        .setName('metrics')
        .setDescription('Состояние экспортёра метрик')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
      async execute({ interaction }, { config }) {
        await interaction.editReply(
          notice(
            config.metricsEnabled
              ? 'Экспортёр включён. Endpoint /metrics на отдельном порту; требуется bearer token.'
              : 'Экспортёр выключен. Включите его в настройках панели; METRICS_TOKEN задаётся в ENV.',
          ),
        );
      },
    },
  ],
};
export default module;
