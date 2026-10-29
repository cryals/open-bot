import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { BotModule } from '../../runtime/types.js';
import { menu, notice, rulesView } from '../../render.js';
import { MediaService } from '../../media.js';
import { HttpError } from '../../errors.js';

const module: BotModule = {
  id: 'info',
  title: 'Info',
  description: 'Информация проекта и персональные страницы правил.',
  dependencies: ['core'],
  commands: [
    {
      data: new SlashCommandBuilder().setName('info').setDescription('Открыть правила Discord и игры'),
      async execute({ interaction }, { store }) {
        const document = store.active();
        if (!document) throw new HttpError(400, 'Правила ещё не опубликованы. Обратитесь к администрации.');
        await interaction.editReply(menu(document, interaction.user.id));
      },
    },
    {
      admin: true,
      data: new SlashCommandBuilder()
        .setName('send-info')
        .setDescription('Отправить или обновить опубликованную информацию проекта')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Канал; по умолчанию используется канал из настроек')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
      async execute({ interaction, signal }, { publisher }) {
        const channel = interaction.options.getChannel('channel');
        const result = await publisher.publish(
          { userId: interaction.user.id, name: interaction.user.username },
          { channelId: channel?.id, signal },
        );
        await interaction.editReply(
          notice(
            `Информация обновлена в <#${result.channelId}>.\n[Открыть сообщение](https://discord.com/channels/${interaction.guildId}/${result.channelId}/${result.messageId})`,
          ),
        );
      },
    },
  ],
  buttons: [
    {
      prefix: 'os:v1:',
      async execute(interaction, { store }) {
        const parts = interaction.customId.split(':');
        const action = parts[2];
        if (!['open', 'menu', 'page'].includes(action))
          throw new HttpError(400, 'Кнопка устарела. Откройте /info.');
        if (action !== 'open' && parts[3] !== interaction.user.id)
          throw new HttpError(403, 'Откройте собственную панель через /info или «Читать правила».');
        if (action === 'open') await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        else await interaction.deferUpdate();
        const document = store.active();
        if (!document) throw new HttpError(400, 'Правила ещё не опубликованы.');
        const key = parts[4];
        const page = Number(parts[5]);
        const payload =
          action === 'page' &&
          (key === 'game' || key === 'discord') &&
          Number.isSafeInteger(page) &&
          page >= 0
            ? rulesView(document, key, page, interaction.user.id)
            : menu(document, interaction.user.id);
        await interaction.editReply({ ...new MediaService(store).prepare(payload), attachments: [] });
      },
    },
  ],
};
export default module;
