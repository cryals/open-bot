import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import type { BotModule, BotContext } from '../../runtime/types.js';
import { TicketService } from './service.js';
import { notice } from '../../render.js';
import { HttpError } from '../../errors.js';
const services = new WeakMap<object, TicketService>();
function service(context: BotContext) {
  let result = services.get(context.store);
  if (!result) {
    result = new TicketService(
      context.config,
      context.store,
      context.discord,
      context.activity,
      (error, scope) => context.errors.report(error, scope),
    );
    services.set(context.store, result);
  }
  return result;
}
let timer: ReturnType<typeof setInterval> | undefined;
let rawHandler: ((event: { t?: string; d?: Record<string, unknown> }) => void) | undefined;
const menu = (api: TicketService, user: string) => {
  const categories = api.tickets.config().document.categories.filter((category) => category.enabled);
  if (!categories.length) throw new HttpError(400, 'Нет доступных категорий обращений');
  return {
    ...notice('## Поддержка\nВыберите категорию обращения.'),
    components: [
      ...notice('## Поддержка\nВыберите категорию обращения.').components,
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('ob:ticket:choose:' + user)
          .setPlaceholder('Категория обращения')
          .addOptions(
            categories.map((category) => ({
              label: category.name,
              value: category.id,
              ...(category.description ? { description: category.description.slice(0, 100) } : {}),
              ...(category.emoji ? { emoji: category.emoji } : {}),
            })),
          ),
      ),
    ],
  };
};
const module: BotModule = {
  id: 'ticket',
  title: 'Ticket',
  description: 'Приватные обращения, служебные ветки и веб-архив.',
  dependencies: ['core'],
  async start(context) {
    const api = service(context);
    if (context.config.ticketEnabled) {
      await api.recover();
      rawHandler = (event) =>
        void api.raw(event).catch((error) => context.errors.report(error, 'ticket.gateway'));
      context.discord.client.on('raw', rawHandler);
    }
    timer = setInterval(
      () =>
        void (context.config.ticketEnabled ? api.tick() : api.purgeExpired()).catch((error) =>
          context.errors.report(error, 'ticket.jobs'),
        ),
      2000,
    );
    timer.unref();
  },
  async stop(context) {
    clearInterval(timer);
    if (rawHandler) context.discord.client.off('raw', rawHandler);
    rawHandler = undefined;
  },
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('Обращения в поддержку')
        .addSubcommand((command) => command.setName('open').setDescription('Создать обращение'))
        .addSubcommand((command) => command.setName('mine').setDescription('Мои активные обращения')),
      async execute({ interaction }, context) {
        const api = service(context);
        if (interaction.options.getSubcommand() === 'open') {
          await interaction.editReply(menu(api, interaction.user.id));
          return;
        }
        const tickets = context.store.sqlite
          .prepare(
            "SELECT id,state,channel_id FROM tickets WHERE author_id=? AND state IN ('creating','open','claimed','waiting','closing') ORDER BY id DESC",
          )
          .all(interaction.user.id) as { id: number; state: string; channel_id: string | null }[];
        await interaction.editReply(
          notice(
            '## Мои обращения\n' +
              (tickets
                .map(
                  (ticket) =>
                    `**#${ticket.id}** · ${ticket.state}${ticket.channel_id ? ' · <#' + ticket.channel_id + '>' : ''}`,
                )
                .join('\n') || 'Активных обращений нет.'),
          ),
        );
      },
    },
    {
      permission: 'ticketManage',
      data: new SlashCommandBuilder()
        .setName('ticket-panel')
        .setDescription('Опубликовать панель тикетов')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addChannelOption((option) =>
          option.setName('channel').setDescription('Канал панели').setRequired(true),
        ),
      async execute({ interaction }, context) {
        const api = service(context);
        if (!(await api.access(interaction.user.id)).ticketManage)
          throw new HttpError(403, 'Нужна полная роль Ticket');
        await api.publish(interaction.options.getChannel('channel', true).id, {
          userId: interaction.user.id,
          name: interaction.user.username,
        });
        await interaction.editReply(
          notice('Панель поставлена в очередь публикации. Результат появится в веб-панели.'),
        );
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('ticket-manage')
        .setDescription('Управление текущим тикетом')
        .addStringOption((option) =>
          option
            .setName('action')
            .setDescription('Действие')
            .setRequired(true)
            .addChoices(
              { name: 'Добавить участника', value: 'add' },
              { name: 'Убрать участника', value: 'remove' },
              { name: 'Сменить категорию', value: 'category' },
            ),
        )
        .addStringOption((option) =>
          option.setName('value').setDescription('ID участника или категории').setRequired(true),
        ),
      async execute({ interaction }, context) {
        const api = service(context);
        const ticket = context.store.sqlite
          .prepare('SELECT id FROM tickets WHERE channel_id=?')
          .get(interaction.channelId) as { id: number } | undefined;
        if (!ticket) throw new HttpError(400, 'Команда работает в канале тикета');
        await api.change(
          ticket.id,
          { userId: interaction.user.id, name: interaction.user.username },
          interaction.options.getString('action', true) as 'add' | 'remove' | 'category',
          interaction.options.getString('value', true),
        );
        await interaction.editReply(notice('Изменение принято в очередь. Результат появится в веб-панели.'));
      },
    },
  ],
  interactions: [
    {
      prefix: 'ob:ticket:',
      async execute(interaction, context) {
        const api = service(context),
          parts = interaction.customId.split(':'),
          action = parts[2],
          actor = { userId: interaction.user.id, name: interaction.user.username };
        if (action === 'menu') {
          if (!interaction.isButton()) return;
          await interaction.reply({
            ...menu(api, actor.userId),
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          });
          return;
        }
        if (action === 'choose' || action === 'new') {
          const owner = action === 'choose' ? parts[3] : parts[4];
          if (owner !== actor.userId) throw new HttpError(403, 'Откройте своё меню /ticket open');
          const id = interaction.isStringSelectMenu() ? interaction.values[0] : parts[3];
          const category = api.category(id);
          if (category.questions.length) {
            if (interaction.isModalSubmit()) return;
            const modal = new ModalBuilder()
              .setCustomId(`ob:ticket:form:${id}:${actor.userId}`)
              .setTitle(category.name.slice(0, 45));
            for (const question of category.questions)
              modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                  new TextInputBuilder()
                    .setCustomId(question.id)
                    .setLabel(question.label)
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(question.required)
                    .setMaxLength(2000),
                ),
              );
            await interaction.showModal(modal);
            return;
          }
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const ticket = api.reserve(actor.userId, id);
          await interaction.editReply(
            notice(
              `Обращение **#${ticket.id}** принято. Бот создаёт закрытый канал; он появится в списке каналов и в /ticket mine.`,
            ),
          );
          return;
        }
        if (action === 'form') {
          if (!interaction.isModalSubmit() || parts[4] !== actor.userId)
            throw new HttpError(403, 'Форма устарела');
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const category = api.category(parts[3]);
          const answers = Object.fromEntries(
            category.questions.map((question) => [
              question.id,
              interaction.fields.getTextInputValue(question.id),
            ]),
          );
          const ticket = api.reserve(actor.userId, category.id, answers);
          await interaction.editReply(
            notice(
              `Обращение **#${ticket.id}** принято. Канал создаётся; команда /ticket mine покажет результат.`,
            ),
          );
          return;
        }
        const id = Number(parts[3]);
        if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, 'Некорректный тикет');
        if (action === 'close') {
          if (!interaction.isButton()) return;
          const ticket = api.tickets.get(id);
          if (!(await api.canClose(ticket, actor.userId)))
            throw new HttpError(403, 'Нет права закрыть тикет');
          await interaction.showModal(
            new ModalBuilder()
              .setCustomId(`ob:ticket:finish:${id}`)
              .setTitle('Закрыть тикет #' + id)
              .addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                  new TextInputBuilder()
                    .setCustomId('reason')
                    .setLabel('Причина закрытия')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMaxLength(1000),
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                  new TextInputBuilder()
                    .setCustomId('confirm')
                    .setLabel('Для подтверждения напишите ЗАКРЫТЬ')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true),
                ),
              ),
          );
          return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (action === 'finish' && interaction.isModalSubmit()) {
          if (interaction.fields.getTextInputValue('confirm').trim().toUpperCase() !== 'ЗАКРЫТЬ')
            throw new HttpError(400, 'Закрытие не подтверждено');
          await api.change(id, actor, 'close', interaction.fields.getTextInputValue('reason'));
          await interaction.editReply(
            notice('Закрытие принято. Канал будет удалён после сохранения архива.'),
          );
          return;
        }
        if (action === 'staff') {
          const link = await api.join(id, actor.userId);
          await interaction.editReply(notice('[Открыть служебное обсуждение](' + link + ')'));
          return;
        }
        if (action === 'claim' || action === 'waiting') {
          await api.change(id, actor, action);
          await interaction.editReply(notice('Состояние тикета обновлено.'));
          return;
        }
        throw new HttpError(400, 'Кнопка устарела');
      },
    },
  ],
};
export default module;
