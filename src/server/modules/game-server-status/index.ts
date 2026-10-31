import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import type { BotModule, BotContext } from '../../runtime/types.js';
import { ServerStatusService } from './service.js';
import { customMessage } from '../../blocks.js';
import { notice } from '../../render.js';
import { gameTypeSchema, gameTitles, type GameType } from '../../../shared/game-servers.js';
const services = new WeakMap<object, ServerStatusService>();
function service(context: BotContext) {
  let result = services.get(context.store);
  if (!result) {
    result = new ServerStatusService(context.config, context.store, context.discord, (error, scope) =>
      context.errors.report(error, scope),
    );
    services.set(context.store, result);
  }
  return result;
}
let timer: ReturnType<typeof setInterval> | undefined;
const module: BotModule = {
  id: 'game-server-status',
  title: 'Game Server Status',
  description: 'Мониторинг SS14, SS13, Minecraft, Terraria и Project Zomboid с обновляемыми сообщениями.',
  dependencies: ['core'],
  async start(context) {
    timer = setInterval(
      () =>
        void service(context)
          .tick()
          .catch((error) => context.errors.report(error, 'game-server-status.tick')),
      5000,
    );
    timer.unref();
  },
  async stop() {
    clearInterval(timer);
  },
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('server-status')
        .setDescription('Статус игрового сервера или список серверов')
        .addStringOption((option) => option.setName('server').setDescription('ID сервера')),
      async execute({ interaction }, context) {
        const api = service(context),
          id = interaction.options.getString('server');
        const servers = api.settings().document.servers;
        if (!id) {
          await interaction.editReply(
            notice(
              '## Игровые серверы\n' +
                (servers.map((server) => `**${server.id}** — ${server.name}`).join('\n') ||
                  'Серверы пока не настроены.'),
            ),
          );
          return;
        }
        const status = await api.get(id);
        await interaction.editReply(
          customMessage(
            api.message(
              servers.find((server) => server.id === id)!,
              status,
            ),
          ),
        );
      },
    },
    {
      admin: true,
      data: new SlashCommandBuilder()
        .setName('server-config')
        .setDescription('Управление статусами серверов')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand((command) =>
          command
            .setName('add')
            .setDescription('Добавить игровой сервер')
            .addStringOption((option) => option.setName('id').setDescription('Короткий ID').setRequired(true))
            .addStringOption((option) => option.setName('name').setDescription('Название').setRequired(true))
            .addStringOption((option) =>
              option
                .setName('address')
                .setDescription('Адрес status API или host:query-port')
                .setRequired(true),
            )
            .addStringOption((option) =>
              option
                .setName('game')
                .setDescription('Игра; по умолчанию SS14')
                .addChoices(...gameTypeSchema.options.map((value) => ({ name: gameTitles[value], value }))),
            )
            .addStringOption((option) =>
              option.setName('token-env').setDescription('Имя GAME_SERVER_TOKEN_* для Terraria TShock'),
            ),
        )
        .addSubcommand((command) =>
          command
            .setName('remove')
            .setDescription('Удалить сервер')
            .addStringOption((option) => option.setName('id').setDescription('ID сервера').setRequired(true)),
        )
        .addSubcommand((command) =>
          command
            .setName('watch')
            .setDescription('Обновляемый статус в канале')
            .addStringOption((option) =>
              option.setName('server').setDescription('ID сервера').setRequired(true),
            )
            .addChannelOption((option) =>
              option
                .setName('channel')
                .setDescription('Канал')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true),
            ),
        )
        .addSubcommand((command) =>
          command
            .setName('unwatch')
            .setDescription('Убрать обновляемый статус')
            .addIntegerOption((option) =>
              option.setName('id').setDescription('ID наблюдения').setRequired(true),
            ),
        )
        .addSubcommand((command) => command.setName('list').setDescription('Серверы и наблюдения')),
      async execute({ interaction }, context) {
        const api = service(context),
          action = interaction.options.getSubcommand(),
          snapshot = api.settings();
        if (action === 'add') {
          snapshot.document.servers.push({
            id: interaction.options.getString('id', true),
            name: interaction.options.getString('name', true),
            address: interaction.options.getString('address', true),
            game: (interaction.options.getString('game') as GameType | null) || 'ss14',
            tokenEnv: interaction.options.getString('token-env'),
          });
          api.save(snapshot.document, snapshot.version);
        }
        if (action === 'remove')
          api.save(
            {
              servers: snapshot.document.servers.filter(
                (server) => server.id !== interaction.options.getString('id', true),
              ),
            },
            snapshot.version,
          );
        if (action === 'watch')
          await api.addWatch(
            interaction.options.getString('server', true),
            interaction.options.getChannel('channel', true).id,
          );
        if (action === 'unwatch') api.removeWatch(interaction.options.getInteger('id', true));
        context.activity.record(
          { userId: interaction.user.id, name: interaction.user.username },
          { kind: 'servers.config', target: action, summary: 'Настройки статусов: ' + action },
        );
        await interaction.editReply(
          notice(
            '## Статусы серверов\n' +
              api
                .settings()
                .document.servers.map((server) => `**${server.id}** — ${server.name}`)
                .join('\n') +
              '\n\n' +
              api
                .watches()
                .map(
                  (watch) =>
                    `Наблюдение ${watch.id}: ${watch.server_id} · <#${watch.channel_id}>${watch.error ? ' · ошибка' : ''}`,
                )
                .join('\n'),
          ),
        );
      },
    },
  ],
};
export default module;
