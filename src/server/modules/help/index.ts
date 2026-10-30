import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SlashCommandBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import type { BotContext, BotModule } from '../../runtime/types.js';
import { HttpError } from '../../errors.js';
import { permissions } from '../../access.js';

async function help(context: BotContext, userId: string, filter: string, page: number) {
  const access = await permissions(context.discord, context.store, context.config, userId);
  const admin = access.admin;
  const modules = context.manager.definitions();
  if (filter !== 'all' && !modules.some((module) => module.id === filter) && filter !== 'web')
    throw new HttpError(400, 'Модуль не найден. Используйте /help для списка.');
  const rows = modules
    .filter((module) => filter === 'all' || module.id === filter)
    .flatMap((module) => {
      const commands = (module.commands || []).filter(
        (command) => (!command.admin || admin) && (!command.permission || access[command.permission]),
      );
      return [
        `### ${module.title}\n${module.description}`,
        ...commands.map(
          (command) =>
            `**/${command.data.name}**${command.admin ? ' · администрация' : ''}\n${command.data.description}`,
        ),
      ];
    });
  if (filter === 'all' || filter === 'web')
    rows.push(
      `### Web\nВеб-панель: редактор информации, правила, сообщения и журнал.\nСостояние: **${context.status().web.state}**.`,
    );
  const pages: string[][] = [[]];
  let length = 0;
  for (const row of rows) {
    if (length + row.length > 2400 && pages.at(-1)!.length) {
      pages.push([]);
      length = 0;
    }
    pages.at(-1)!.push(row);
    length += row.length + 2;
  }
  const index = Math.max(0, Math.min(page, pages.length - 1));
  const card = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent('# Справка Open Bot'),
    new TextDisplayBuilder().setContent(
      'Команды добавляются модулями автоматически.\n`/help module:info` — справка по отдельному модулю.',
    ),
    new TextDisplayBuilder().setContent(pages[index].join('\n\n') || 'Нет доступных команд.'),
  );
  if (pages.length > 1)
    card.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`os:help:${userId}:${filter}:${index - 1}`)
          .setLabel('← Назад')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(index === 0),
        new ButtonBuilder()
          .setCustomId(`os:help:${userId}:${filter}:${index}`)
          .setLabel(`${index + 1} / ${pages.length}`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`os:help:${userId}:${filter}:${index + 1}`)
          .setLabel('Вперёд →')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(index === pages.length - 1),
      ),
    );
  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components: [card],
    allowedMentions: { parse: [] as never[] },
  };
}
const module: BotModule = {
  id: 'help',
  title: 'Help',
  description: 'Справка из актуального реестра модулей и команд.',
  dependencies: ['core'],
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Список доступных команд по модулям')
        .addStringOption((option) =>
          option
            .setName('module')
            .setDescription('ID модуля: core, help, info, web или другой установленный модуль'),
        ),
      async execute({ interaction }, context) {
        await interaction.editReply(
          await help(context, interaction.user.id, interaction.options.getString('module') || 'all', 0),
        );
      },
    },
  ],
  buttons: [
    {
      prefix: 'os:help:',
      async execute(interaction, context) {
        const [, , owner, filter, page] = interaction.customId.split(':');
        if (owner !== interaction.user.id)
          throw new HttpError(403, 'Откройте собственную справку через /help.');
        await interaction.deferUpdate();
        await interaction.editReply(await help(context, owner, filter, Number(page) || 0));
      },
    },
  ],
};
export default module;
