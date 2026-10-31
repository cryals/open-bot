import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import type { ModuleContext, BotModule, BotCommand } from '../../runtime/types.js';
import { ModerationService } from './service.js';
import { actionTitles, type ModerationAction } from '../../../shared/moderation.js';
import { notice } from '../../render.js';
import { HttpError } from '../../errors.js';
const services = new WeakMap<object, ModerationService>();
export function moderation(context: ModuleContext) {
  let api = services.get(context.store);
  if (!api) {
    api = new ModerationService(
      context.config,
      context.store,
      context.discord,
      context.activity,
      (error, scope) => context.errors.report(error, scope),
    );
    services.set(context.store, api);
  }
  return api;
}
let timer: ReturnType<typeof setInterval> | undefined;
const actions: ModerationAction[] = [
  'warn',
  'note',
  'kick',
  'ban',
  'tempban',
  'softban',
  'unban',
  'timeout',
  'untimeout',
  'role-mute',
  'unmute',
  'purge',
  'lock',
  'unlock',
];
const commands: BotCommand[] = actions.map((action) => {
  let data = new SlashCommandBuilder()
    .setName(action)
    .setDescription(actionTitles[action])
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addStringOption((option) =>
      option
        .setName('target')
        .setDescription(['purge', 'lock', 'unlock'].includes(action) ? 'ID канала' : 'ID участника')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('Причина действия').setRequired(true),
    );
  if (['ban', 'tempban', 'timeout', 'role-mute'].includes(action))
    data = data.addIntegerOption((option) =>
      option.setName('seconds').setDescription('Срок в секундах').setMinValue(1),
    );
  if (action === 'purge')
    data = data.addIntegerOption((option) =>
      option
        .setName('count')
        .setDescription('Количество последних сообщений для отбора')
        .setMinValue(1)
        .setMaxValue(1000)
        .setRequired(true),
    );
  if (['ban', 'tempban', 'softban'].includes(action))
    data = data.addIntegerOption((option) =>
      option
        .setName('delete_seconds')
        .setDescription('Удалить историю за число секунд (0 по умолчанию)')
        .setMinValue(0)
        .setMaxValue(604800),
    );
  return {
    data,
    permission: 'moderationManage',
    async execute({ interaction }, context) {
      const row = await moderation(context).prepare(
        {
          action,
          target: interaction.options.getString('target', true),
          reason: interaction.options.getString('reason', true),
          duration: interaction.options.getInteger('seconds'),
          deleteSeconds: interaction.options.getInteger('delete_seconds') || 0,
          purge:
            action === 'purge'
              ? { count: interaction.options.getInteger('count', true), type: 'all', includePinned: false }
              : undefined,
          operationId: crypto.randomUUID(),
        },
        { userId: interaction.user.id, name: interaction.user.username },
        'slash',
      );
      await interaction.editReply({
        ...notice(
          `## ${actionTitles[action]} · #${row.id}\nЦель: ${row.target}\nПричина: ${row.reason}\nСрок: ${row.duration ? row.duration + ' сек.' : 'не применяется / бессрочно'}\nПодтверждение действительно 90 секунд.`,
        ),
        components: [
          ...notice(
            `## ${actionTitles[action]} · #${row.id}\nЦель: ${row.target}\nПричина: ${row.reason}\nСрок: ${row.duration ? row.duration + ' сек.' : 'не применяется / бессрочно'}\nПодтверждение действительно 90 секунд.`,
          ).components,
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`ob:mod:confirm:${row.id}:${interaction.user.id}`)
              .setLabel('Подтвердить')
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId(`ob:mod:cancel:${row.id}:${interaction.user.id}`)
              .setLabel('Отмена')
              .setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    },
  };
});
commands.push({
  permission: 'moderationView',
  data: new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('Предупреждения участника')
    .addStringOption((option) => option.setName('target').setDescription('ID участника').setRequired(true)),
  async execute({ interaction }, context) {
    const rows = moderation(context)
      .list(interaction.options.getString('target', true))
      .filter((row) => row.action === 'warn');
    await interaction.editReply(
      notice(
        '## Предупреждения\n' +
          (rows
            .map((row) => `#${row.id} · ${row.revoked ? 'отменено' : row.state} · ${row.reason}`)
            .join('\n')
            .slice(0, 3000) || 'Нет предупреждений.'),
      ),
    );
  },
});
commands.push({
  permission: 'moderationView',
  data: new SlashCommandBuilder()
    .setName('case')
    .setDescription('Дело модерации')
    .addIntegerOption((option) =>
      option.setName('id').setDescription('Номер дела').setRequired(true).setMinValue(1),
    ),
  async execute({ interaction }, context) {
    const row = moderation(context).get(interaction.options.getInteger('id', true));
    await interaction.editReply(
      notice(
        `## Дело #${row.id}\n${actionTitles[row.action]} · ${row.state}\nКого: ${row.target}\nКто: ${row.actor}\nПочему: ${row.reason}\nСрок: ${row.duration ? row.duration + ' сек.' : 'не применяется / бессрочно'}`,
      ),
    );
  },
});
const module: BotModule = {
  id: 'moderation',
  title: 'Moderation',
  description: 'Дела, предупреждения и подтверждаемые наказания.',
  dependencies: ['core'],
  requirements: { permissions: [PermissionFlagsBits.ModerateMembers] },
  commands,
  async start(context) {
    timer = setInterval(
      () =>
        void moderation(context)
          .tick()
          .catch((error) => context.errors.report(error, 'moderation.tick')),
      1000,
    );
    timer.unref();
  },
  async stop() {
    clearInterval(timer);
  },
  buttons: [
    {
      prefix: 'ob:mod:',
      async execute(interaction, context) {
        const [, , action, id, actor] = interaction.customId.split(':');
        if (actor !== interaction.user.id) throw new HttpError(403, 'Операция другого исполнителя');
        await interaction.deferUpdate();
        if (action === 'confirm') await moderation(context).confirm(Number(id), actor);
        else moderation(context).cancel(Number(id), actor);
        await interaction.editReply(
          notice(
            action === 'confirm' ? 'Действие принято. Результат будет в журнале дел.' : 'Действие отменено.',
          ),
        );
      },
    },
  ],
};
export default module;
