import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import type { BotModule, BotContext } from '../../runtime/types.js';
import { WatchdogService } from './service.js';
import { notice } from '../../render.js';
import { HttpError } from '../../errors.js';
import type { PowerAction } from '../../../shared/modules.js';
const service = (context: BotContext) =>
  new WatchdogService(context.config, context.store, context.activity, (error, scope) =>
    context.errors.report(error, scope),
  );
let timer: ReturnType<typeof setInterval> | undefined;
const module: BotModule = {
  id: 'watchdog',
  title: 'SS14 Watchdog',
  description: 'Подтверждаемые операции питания, обновления и отката SS14.',
  dependencies: ['core'],
  async start(context) {
    service(context).recover();
    timer = setInterval(() => {
      try {
        service(context).recover();
      } catch (error) {
        context.errors.report(error, 'watchdog.recovery');
      }
    }, 30000);
    timer.unref();
  },
  async stop() {
    clearInterval(timer);
  },
  commands: [
    {
      admin: true,
      data: new SlashCommandBuilder()
        .setName('watchdog')
        .setDescription('SS14 Watchdog: питание и версии')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand((command) => command.setName('list').setDescription('Настроенные Watchdog-серверы'))
        .addSubcommand((command) =>
          command
            .setName('add')
            .setDescription('Добавить Watchdog-сервер; токен хранится в ENV')
            .addStringOption((option) => option.setName('id').setDescription('ID сервера').setRequired(true))
            .addStringOption((option) =>
              option.setName('address').setDescription('Базовый HTTP(S) URL').setRequired(true),
            )
            .addStringOption((option) =>
              option.setName('instance').setDescription('Watchdog instance ID').setRequired(true),
            )
            .addStringOption((option) =>
              option.setName('token-env').setDescription('Имя WATCHDOG_TOKEN_…').setRequired(true),
            ),
        )
        .addSubcommand((command) =>
          command
            .setName('remove')
            .setDescription('Убрать Watchdog-сервер')
            .addStringOption((option) => option.setName('id').setDescription('ID сервера').setRequired(true)),
        )
        .addSubcommand((command) =>
          command
            .setName('versions')
            .setDescription('Доступные версии')
            .addStringOption((option) =>
              option.setName('server').setDescription('ID сервера').setRequired(true),
            ),
        )
        .addSubcommand((command) =>
          command
            .setName('action')
            .setDescription('Подготовить действие с подтверждением')
            .addStringOption((option) =>
              option.setName('server').setDescription('ID сервера').setRequired(true),
            )
            .addStringOption((option) =>
              option
                .setName('action')
                .setDescription('Действие')
                .setRequired(true)
                .addChoices(
                  { name: 'Restart', value: 'restart' },
                  { name: 'Update', value: 'update' },
                  { name: 'Stop после раунда', value: 'stop' },
                  { name: 'Revert', value: 'revert' },
                ),
            )
            .addStringOption((option) => option.setName('version').setDescription('Версия для revert'))
            .addBooleanOption((option) =>
              option.setName('immediate').setDescription('Прервать раунд при revert'),
            ),
        )
        .addSubcommand((command) =>
          command.setName('restart-network').setDescription('Подготовить перезапуск всех серверов'),
        ),
      async execute({ interaction }, context) {
        const api = service(context),
          action = interaction.options.getSubcommand();
        if (action === 'add' || action === 'remove') {
          const snapshot = api.settings(),
            id = interaction.options.getString('id', true);
          const servers =
            action === 'remove'
              ? snapshot.document.servers.filter((server) => server.id !== id)
              : [
                  ...snapshot.document.servers,
                  {
                    id,
                    name: id,
                    address: interaction.options.getString('address', true),
                    instance: interaction.options.getString('instance', true),
                    tokenEnv: interaction.options.getString('token-env', true),
                  },
                ];
          api.save({ servers }, snapshot.version);
          context.activity.record(
            { userId: interaction.user.id, name: interaction.user.username },
            { kind: 'watchdog.settings', target: id, summary: 'Watchdog: ' + action },
          );
          await interaction.editReply(notice('Настройки Watchdog сохранены.'));
          return;
        }
        if (action === 'list') {
          await interaction.editReply(
            notice(
              '## Watchdog\n' +
                (api
                  .settings()
                  .document.servers.map((server) => `**${server.id}** — ${server.name}`)
                  .join('\n') || 'Серверы не настроены. Добавьте их в веб-панели.'),
            ),
          );
          return;
        }
        if (action === 'versions') {
          const versions = await api.versions(interaction.options.getString('server', true));
          await interaction.editReply(
            notice(
              '## Версии\n' +
                versions
                  .slice(0, 25)
                  .map((version) => `\`${version.version}\`${version.current ? ' · текущая' : ''}`)
                  .join('\n'),
            ),
          );
          return;
        }
        if (action === 'restart-network') {
          const batch = api.prepareBatch(interaction.user.id);
          await interaction.editReply({
            flags: MessageFlags.IsComponentsV2,
            components: [
              new ContainerBuilder()
                .addTextDisplayComponents(
                  new TextDisplayBuilder().setContent(
                    '## Подтвердить перезапуск всей сети?\nСерверы: ' +
                      batch.servers.join(', ') +
                      '\nСрок подтверждения — 90 секунд.',
                  ),
                )
                .addActionRowComponents(
                  new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                      .setCustomId('ob:power:batch:' + batch.id)
                      .setStyle(ButtonStyle.Danger)
                      .setLabel('Перезапустить сеть'),
                    new ButtonBuilder()
                      .setCustomId('ob:power:cancel-batch:' + batch.id)
                      .setStyle(ButtonStyle.Secondary)
                      .setLabel('Отмена'),
                  ),
                ),
            ],
            allowedMentions: { parse: [] },
          });
          return;
        }
        const operations = [
          api.prepare(
            interaction.user.id,
            interaction.options.getString('server', true),
            interaction.options.getString('action', true) as PowerAction,
            interaction.options.getString('version') || undefined,
            interaction.options.getBoolean('immediate') || false,
          ),
        ];
        if (!operations.length) throw new HttpError(400, 'Серверы не настроены');
        // One confirmation per server also bounds interaction payloads and prevents a hidden all-server retry.
        await interaction.editReply({
          flags: MessageFlags.IsComponentsV2,
          components: operations.slice(0, 10).map((operation) =>
            new ContainerBuilder()
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `## Подтвердить ${operation.action}: ${operation.server_id}?\n${operation.immediate ? 'Раунд будет прерван.' : 'Действие может повлиять на игроков.'}\nПодтверждение действительно 90 секунд.`,
                ),
              )
              .addActionRowComponents(
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                  new ButtonBuilder()
                    .setCustomId('ob:power:confirm:' + operation.id)
                    .setLabel('Подтвердить')
                    .setStyle(ButtonStyle.Danger),
                  new ButtonBuilder()
                    .setCustomId('ob:power:cancel:' + operation.id)
                    .setLabel('Отмена')
                    .setStyle(ButtonStyle.Secondary),
                ),
              ),
          ),
          allowedMentions: { parse: [] },
        });
      },
    },
  ],
  buttons: [
    {
      prefix: 'ob:power:',
      async execute(interaction, context) {
        await interaction.deferUpdate();
        if (!(await context.discord.authorize(interaction.user.id, context.store.getSettings().adminRoleId)))
          throw new HttpError(403, 'Нужны права администратора');
        const [, , action, id] = interaction.customId.split(':');
        const api = service(context);
        if (action === 'cancel' || action === 'cancel-batch') {
          if (action === 'cancel') api.cancel(id, interaction.user.id);
          else api.cancelBatch(id, interaction.user.id);
          await interaction.editReply(notice('Операция отменена.'));
          return;
        }
        if (action === 'batch') {
          const results = await api.confirmBatch(id, {
            userId: interaction.user.id,
            name: interaction.user.username,
          });
          await interaction.editReply(
            notice(
              '## Результат сети\n' +
                results
                  .map((result) => `**${result.server_id}**: ${result.state} · ${result.result}`)
                  .join('\n'),
            ),
          );
          return;
        }
        const operation = await api.confirm(id, {
          userId: interaction.user.id,
          name: interaction.user.username,
        });
        await interaction.editReply(notice(operation.result || operation.state));
      },
    },
  ],
};
export default module;
