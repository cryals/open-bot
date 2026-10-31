import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { BotModule, BotCommand, BotContext } from './runtime/types.js';
import { communityDefinitions, type CommunityModuleId } from '../shared/community.js';
import { community } from './community-runtime.js';
import { notice } from './render.js';
import { JobStore } from './jobs.js';
import { requireCapability } from './access.js';
import { HttpError } from './errors.js';
import type { FormDraft } from './modules/forms/service.js';
import { GuildAuthority } from './authority.js';
import { canonicalSource } from './modules/subscriptions/providers.js';
import { feedSchema } from '../shared/community.js';
import { saveCommunityConfiguration, modulePermissions } from './community-config.js';
const roots: Record<CommunityModuleId, string> = {
  automod: 'automod',
  autoban: 'autoban',
  'anti-raid': 'raid',
  slowmode: 'slowmode',
  'role-menus': 'role-panel',
  autoresponder: 'autoresponder',
  'custom-commands': 'custom',
  forms: 'form',
  giveaways: 'giveaway',
  subscriptions: 'feed',
  starboard: 'starboard',
  'guild-backup': 'backup',
};
const enqueue = (context: BotContext, kind: string, value: unknown, actor: string) => {
  const id = crypto.randomUUID();
  new JobStore(context.store).enqueue(id, 'community.' + kind, id, { ...(value as object), actor });
  return id;
};
const nextForm = (draft: FormDraft) => ({
  ...notice(`## ${draft.definition.title}\nЗаполнено ${draft.step} из ${draft.definition.questions.length}.`),
  components: [
    ...notice(
      `## ${draft.definition.title}\nЗаполнено ${draft.step} из ${draft.definition.questions.length}.`,
    ).components,
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(
          `ob:form:${draft.step >= draft.definition.questions.length ? 'submit' : 'step'}:${draft.id}:${draft.step}:${draft.user}`,
        )
        .setLabel(draft.step >= draft.definition.questions.length ? 'Отправить заявку' : 'Продолжить')
        .setStyle(ButtonStyle.Primary),
    ),
  ],
});
async function formInteraction(
  interaction: ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  context: BotContext,
) {
  const [, , action, id, step, user] = interaction.customId.split(':');
  if (user !== interaction.user.id) throw new HttpError(403, 'Откройте собственную форму через /form open');
  const forms = community(context).forms,
    draft = forms.draft(id, user);
  if (Number(step) !== draft.step) throw new HttpError(409, 'Этот шаг уже пройден');
  if (action === 'step' && interaction.isButton()) {
    const question = draft.definition.questions[draft.step];
    if (!question) throw new HttpError(400, 'Все вопросы заполнены');
    if (question.type === 'single' || question.type === 'multiple') {
      await interaction.reply({
        ...notice(question.label),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        components: [
          ...notice(question.label).components,
          {
            type: 1,
            components: [
              {
                type: 3,
                custom_id: `ob:form:select:${id}:${step}:${user}`,
                min_values: question.required ? 1 : 0,
                max_values: question.type === 'single' ? 1 : question.choices.length,
                options: question.choices.map((choice, index) => ({ label: choice, value: String(index) })),
              },
            ],
          },
        ],
      });
      return;
    }
    const questions = draft.definition.questions
      .slice(draft.step, draft.step + 5)
      .filter(
        (question, index, list) =>
          ['short', 'long'].includes(question.type) &&
          list.slice(0, index).every((previous) => ['short', 'long'].includes(previous.type)),
      );
    const modal = new ModalBuilder()
      .setCustomId(`ob:form:answer:${id}:${step}:${user}`)
      .setTitle(draft.definition.title.slice(0, 45));
    for (const question of questions)
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(question.id)
            .setLabel(question.label.slice(0, 45))
            .setStyle(question.type === 'short' ? TextInputStyle.Short : TextInputStyle.Paragraph)
            .setRequired(question.required)
            .setMaxLength(question.type === 'short' ? 1000 : 4000),
        ),
      );
    await interaction.showModal(modal);
    return;
  }
  if (action === 'select' && interaction.isStringSelectMenu()) {
    await interaction.deferUpdate();
    const question = draft.definition.questions[draft.step];
    draft.answers[question.id] = interaction.values
      .map((value) => question.choices[Number(value)])
      .filter(Boolean);
    draft.step++;
    community(context).configs.set('forms', 'draft:' + id, draft);
    await interaction.editReply(nextForm(draft));
    return;
  }
  if (action === 'answer' && interaction.isModalSubmit()) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let count = 0;
    for (const question of draft.definition.questions.slice(draft.step, draft.step + 5)) {
      if (!['short', 'long'].includes(question.type)) break;
      draft.answers[question.id] = interaction.fields.getTextInputValue(question.id);
      count++;
    }
    draft.step += count;
    community(context).configs.set('forms', 'draft:' + id, draft);
    await interaction.editReply(nextForm(draft));
    return;
  }
  if (action === 'submit' && interaction.isButton()) {
    await interaction.deferUpdate();
    if (draft.step !== draft.definition.questions.length) throw new HttpError(400, 'Заполните все вопросы');
    const result = await forms.submit(id, user);
    await interaction.editReply(notice('Заявка #' + result.id + ' отправлена.'));
  }
}
export function makeCommunityModule(id: CommunityModuleId): BotModule {
  const definition = communityDefinitions[id],
    name = roots[id],
    data = new SlashCommandBuilder().setName(name).setDescription(definition.title);
  data.setDefaultMemberPermissions(null);
  for (const verb of ['status', 'enable', 'disable'])
    data.addSubcommand((sub) =>
      sub
        .setName(verb)
        .setDescription(
          { status: 'Состояние модуля', enable: 'Включить модуль', disable: 'Выключить модуль' }[verb]!,
        ),
    );
  if (id === 'role-menus')
    data.addSubcommand((sub) =>
      sub
        .setName('publish')
        .setDescription('Опубликовать панель ролей')
        .addStringOption((option) => option.setName('id').setDescription('ID панели').setRequired(true)),
    );
  if (id === 'anti-raid')
    for (const action of ['start', 'stop'])
      data.addSubcommand((sub) =>
        sub
          .setName(action)
          .setDescription(action === 'start' ? 'Включить защитный режим' : 'Выключить защитный режим')
          .addStringOption((option) => option.setName('reason').setDescription('Причина').setRequired(true)),
      );
  if (id === 'automod')
    data.addSubcommand((sub) => sub.setName('sync').setDescription('Синхронизировать Native AutoMod'));
  if (id === 'forms')
    data
      .addSubcommand((sub) =>
        sub
          .setName('open')
          .setDescription('Заполнить форму')
          .addStringOption((option) => option.setName('id').setDescription('ID формы').setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName('submissions').setDescription('Заявки, доступные сотруднику'));
  if (id === 'custom-commands')
    data.addSubcommand((sub) =>
      sub
        .setName('run')
        .setDescription('Выполнить пользовательскую команду')
        .addStringOption((option) =>
          option.setName('id').setDescription('ID команды').setRequired(true).setAutocomplete(true),
        )
        .addStringOption((option) => option.setName('arguments').setDescription('Аргументы как JSON-объект')),
    );
  if (id === 'giveaways') {
    data.addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Создать розыгрыш')
        .addStringOption((option) => option.setName('prize').setDescription('Приз').setRequired(true))
        .addChannelOption((option) => option.setName('channel').setDescription('Канал').setRequired(true))
        .addIntegerOption((option) =>
          option
            .setName('minutes')
            .setDescription('Длительность в минутах')
            .setMinValue(1)
            .setMaxValue(525600)
            .setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName('winners')
            .setDescription('Число победителей')
            .setMinValue(1)
            .setMaxValue(100)
            .setRequired(true),
        ),
    );
    for (const action of ['end', 'cancel', 'reroll'])
      data.addSubcommand((sub) =>
        sub
          .setName(action)
          .setDescription('Розыгрыш: ' + action)
          .addStringOption((option) => option.setName('id').setDescription('ID розыгрыша').setRequired(true))
          .addStringOption((option) => option.setName('reason').setDescription('Причина').setRequired(true)),
      );
  }
  if (id === 'guild-backup')
    data
      .addSubcommand((sub) => sub.setName('create').setDescription('Создать снимок сервера'))
      .addSubcommand((sub) => sub.setName('list').setDescription('Список копий'))
      .addSubcommand((sub) =>
        sub
          .setName('restore')
          .setDescription('Подготовить восстановление добавлением')
          .addStringOption((option) => option.setName('id').setDescription('ID копии').setRequired(true)),
      );
  if (id === 'starboard')
    data.addSubcommand((sub) =>
      sub
        .setName('hide')
        .setDescription('Скрыть публикацию')
        .addStringOption((option) => option.setName('board').setDescription('ID доски').setRequired(true))
        .addStringOption((option) =>
          option.setName('id').setDescription('ID исходного сообщения').setRequired(true),
        ),
    );
  if (['autoban', 'autoresponder', 'subscriptions'].includes(id))
    data.addSubcommand((sub) => sub.setName('list').setDescription('Список настроенных записей'));
  if (id === 'automod')
    data.addSubcommand((sub) =>
      sub
        .setName('rule')
        .setDescription('Показать правило')
        .addStringOption((option) => option.setName('id').setDescription('ID правила').setRequired(true)),
    );
  if (id === 'role-menus')
    data.addSubcommand((sub) =>
      sub
        .setName('unpublish')
        .setDescription('Отключить опубликованную панель')
        .addStringOption((option) => option.setName('id').setDescription('ID панели').setRequired(true)),
    );
  if (id === 'slowmode')
    for (const mode of ['discord', 'user', 'channel', 'off'])
      data.addSubcommand((sub) => {
        sub
          .setName(mode)
          .setDescription('Slowmode: ' + mode)
          .addChannelOption((option) => option.setName('channel').setDescription('Канал').setRequired(true));
        if (mode !== 'off')
          sub
            .addIntegerOption((option) =>
              option
                .setName('seconds')
                .setDescription('Интервал, секунд')
                .setMinValue(1)
                .setMaxValue(21600)
                .setRequired(true),
            )
            .addIntegerOption((option) =>
              option
                .setName('duration')
                .setDescription('Срок действия, секунд')
                .setMinValue(1)
                .setMaxValue(2592000),
            );
        return sub;
      });
  if (id === 'subscriptions') {
    data.addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Добавить подписку')
        .addStringOption((option) =>
          option
            .setName('provider')
            .setDescription('Платформа')
            .setRequired(true)
            .addChoices(
              ...['youtube', 'twitch', 'kick', 'tiktok', 'reddit', 'vk'].map((value) => ({
                name: value,
                value,
              })),
            ),
        )
        .addStringOption((option) =>
          option.setName('source').setDescription('ID, handle или URL').setRequired(true),
        )
        .addChannelOption((option) =>
          option.setName('channel').setDescription('Канал доставки').setRequired(true),
        ),
    );
    for (const action of ['pause', 'remove'])
      data.addSubcommand((sub) =>
        sub
          .setName(action)
          .setDescription('Подписка: ' + action)
          .addStringOption((option) => option.setName('id').setDescription('ID подписки').setRequired(true)),
      );
  }
  if (id === 'starboard')
    data.addSubcommand((sub) =>
      sub
        .setName('message')
        .setDescription('Публикации сообщения на досках')
        .addStringOption((option) =>
          option.setName('id').setDescription('ID исходного сообщения').setRequired(true),
        ),
    );
  if (id === 'giveaways')
    data.addSubcommand((sub) =>
      sub
        .setName('enter')
        .setDescription('Принять участие с реферером (необязательно)')
        .addStringOption((option) => option.setName('id').setDescription('ID розыгрыша').setRequired(true))
        .addUserOption((option) => option.setName('referrer').setDescription('Кто пригласил')),
    );
  const command: BotCommand = {
    data,
    async execute({ interaction }, context) {
      const action = interaction.options.getSubcommand(),
        runtime = community(context),
        actor = interaction.user.id;
      const queue = (kind: string, value: unknown) => enqueue(context, kind, value, actor);
      if (id === 'giveaways' && action === 'enter') {
        await runtime.giveaways.entry(
          interaction.options.getString('id', true),
          actor,
          true,
          interaction.options.getUser('referrer')?.id,
        );
        await interaction.editReply(notice('Вы участвуете.'));
        return;
      }
      if (id === 'forms' && action === 'open') {
        const draft = await runtime.forms.open(interaction.options.getString('id', true), actor);
        await interaction.editReply(nextForm(draft));
        return;
      }
      if (id === 'custom-commands' && action === 'run') {
        let args;
        try {
          args = JSON.parse(interaction.options.getString('arguments') || '{}');
        } catch {
          throw new HttpError(400, 'Аргументы должны быть JSON-объектом');
        }
        if (!args || typeof args !== 'object' || Array.isArray(args))
          throw new HttpError(400, 'Аргументы должны быть объектом');
        await runtime.custom.run(interaction.options.getString('id', true), interaction, args);
        return;
      }
      if (id === 'forms' && action === 'submissions') {
        await interaction.editReply(
          notice(
            (await runtime.forms.list(actor))
              .map((row) => `#${row.id} · ${row.form_id} · ${row.state}`)
              .join('\n')
              .slice(0, 3000) || 'Нет доступных заявок',
          ),
        );
        return;
      }
      await requireCapability(context.discord, context.store, context.config, actor, definition.capability);
      if (id === 'automod' && action === 'rule') {
        const rule = runtime.configs
          .config('automod')
          .document.rules.find((rule) => rule.id === interaction.options.getString('id', true));
        if (!rule) throw new HttpError(404, 'Правило не найдено');
        await interaction.editReply(
          notice(
            `## ${rule.name}\nФильтр: ${rule.filter}\nПорог: ${rule.threshold}\nРежим: ${rule.observe ? 'наблюдение' : rule.action}`,
          ),
        );
        return;
      }
      if (action === 'list') {
        const document = runtime.configs.config(id).document;
        const items = 'feeds' in document ? document.feeds : 'rules' in document ? document.rules : [];
        await interaction.editReply(
          notice(
            items
              .map((item) => item.id)
              .join('\n')
              .slice(0, 3000) || 'Нет записей',
          ),
        );
        return;
      }
      if (id === 'role-menus' && action === 'unpublish') {
        context.store.sqlite
          .prepare('UPDATE role_panels SET enabled=0 WHERE id=?')
          .run(interaction.options.getString('id', true));
        await interaction.editReply(notice('Панель отключена.'));
        return;
      }
      if (id === 'slowmode' && ['discord', 'user', 'channel', 'off'].includes(action)) {
        const channel = interaction.options.getChannel('channel', true).id;
        await new GuildAuthority(context.config, context.discord, context.store).channel(
          actor,
          channel,
          PermissionFlagsBits.ManageChannels,
        );
        const settings = runtime.configs.config('slowmode'),
          rules = settings.document.rules.filter((rule) => rule.channelId !== channel);
        if (action !== 'off')
          rules.push({
            id: crypto.randomUUID(),
            channelId: channel,
            mode: action as 'discord' | 'user' | 'channel',
            seconds: interaction.options.getInteger('seconds', true),
            expiresAt: interaction.options.getInteger('duration')
              ? Date.now() + interaction.options.getInteger('duration')! * 1000
              : null,
            exceptRoles: [],
          });
        await saveCommunityConfiguration(context, 'slowmode', { enabled: true, rules }, settings.version, {
          userId: actor,
          name: interaction.user.username,
        });
        await interaction.editReply(notice('Slowmode сохранён.'));
        return;
      }
      if (id === 'subscriptions' && ['add', 'pause', 'remove'].includes(action)) {
        const settings = runtime.configs.config('subscriptions');
        let feeds = settings.document.feeds;
        if (action === 'add') {
          const provider = interaction.options.getString('provider', true) as 'youtube';
          const channel = interaction.options.getChannel('channel', true).id;
          await new GuildAuthority(context.config, context.discord, context.store).channel(
            actor,
            channel,
            PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages,
          );
          feeds = [
            ...feeds,
            feedSchema.parse({
              id: crypto.randomUUID(),
              provider,
              source: canonicalSource(provider, interaction.options.getString('source', true)),
              channelId: channel,
            }),
          ];
        } else {
          const feedId = interaction.options.getString('id', true);
          if (!feeds.some((feed) => feed.id === feedId)) throw new HttpError(404, 'Подписка не найдена');
          feeds =
            action === 'remove'
              ? feeds.filter((feed) => feed.id !== feedId)
              : feeds.map((feed) => (feed.id === feedId ? { ...feed, enabled: false } : feed));
        }
        await saveCommunityConfiguration(
          context,
          'subscriptions',
          { ...settings.document, feeds },
          settings.version,
          { userId: actor, name: interaction.user.username },
        );
        await interaction.editReply(notice('Подписки сохранены.'));
        return;
      }
      if (id === 'starboard' && action === 'message') {
        const rows = context.store.sqlite
          .prepare('SELECT board_id,message_id,votes,hidden FROM starboard_messages WHERE source_id=?')
          .all(interaction.options.getString('id', true));
        await interaction.editReply(notice(JSON.stringify(rows).slice(0, 3000)));
        return;
      }
      if (action === 'enable' || action === 'disable') {
        await runtime.setEnabled(id, action === 'enable', actor);
        await interaction.editReply(notice('Модуль ' + (action === 'enable' ? 'включён' : 'выключен')));
        return;
      }
      if (action === 'status') {
        await interaction.editReply(
          notice(
            `## ${definition.title}\n${runtime.configs.config(id).document.enabled ? 'Включён' : 'Выключен'}\nУправление: ${context.config.appOrigin}`,
          ),
        );
        return;
      }
      let result: unknown;
      if (id === 'role-menus')
        result = queue('role-panel', { id: interaction.options.getString('id', true) });
      else if (id === 'anti-raid')
        result = queue('raid-' + action, {
          reason: interaction.options.getString('reason', true),
        });
      else if (id === 'automod') result = queue('native-sync', {});
      else if (id === 'giveaways' && action === 'create')
        result = await runtime.giveaways.create(
          {
            prize: interaction.options.getString('prize', true),
            channelId: interaction.options.getChannel('channel', true).id,
            startsAt: Date.now(),
            endsAt: Date.now() + interaction.options.getInteger('minutes', true) * 60000,
            winners: interaction.options.getInteger('winners', true),
            requiredRoles: [],
            blockedRoles: [],
          },
          actor,
        );
      else if (id === 'giveaways')
        result = queue('giveaway-' + action, {
          id: interaction.options.getString('id', true),
          actor,
          reason: interaction.options.getString('reason', true),
        });
      else if (id === 'guild-backup' && action === 'create') result = runtime.backup.queue(actor);
      else if (id === 'guild-backup' && action === 'list') {
        await interaction.editReply(
          notice(
            runtime.backup
              .list()
              .map((row) => `${row.id} · ${row.state}`)
              .join('\n') || 'Нет копий',
          ),
        );
        return;
      } else if (id === 'guild-backup' && action === 'restore') {
        const plan = await runtime.backup.prepareRestore(interaction.options.getString('id', true), actor, {
          sections: ['roles', 'channels', 'messages'],
          mode: 'add',
        });
        await interaction.editReply({
          ...notice(
            'Подготовлено восстановление добавлением. Будут созданы роли, каналы и последние сообщения; текущие объекты останутся.',
          ),
          components: [
            ...notice(
              '## Восстановление сервера\nПлан: ' + plan.id + '\nДобавление ролей, каналов и сообщений.',
            ).components,
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`ob:backup:confirm:${plan.id}:${actor}`)
                .setLabel('Подтвердить восстановление')
                .setStyle(ButtonStyle.Danger),
            ),
          ],
        });
        return;
      } else if (id === 'starboard')
        result = queue('star-hide', {
          board: interaction.options.getString('board', true),
          id: interaction.options.getString('id', true),
        });
      await interaction.editReply(
        notice(
          'Операция сохранена. ' +
            (typeof result === 'string' ? result : JSON.stringify(result).slice(0, 1500)),
        ),
      );
    },
  };
  if (id === 'custom-commands')
    command.autocomplete = async (interaction, context) => {
      const config = community(context).configs.config('custom-commands').document,
        query = String(interaction.options.getFocused()).toLowerCase();
      await interaction.respond(
        config.enabled
          ? config.commands
              .filter((command) => command.enabled && command.id.toLowerCase().includes(query))
              .slice(0, 25)
              .map((command) => ({ name: command.name, value: command.id }))
          : [],
      );
    };
  const module: BotModule = {
    id,
    title: definition.title,
    description: definition.description,
    dependencies: ['community'],
    commands: [command],
    requirements: {
      permissions: modulePermissions[id],
      intents: ['automod', 'autoresponder', 'slowmode'].includes(id)
        ? ['messages', 'messageContent']
        : ['autoban', 'anti-raid'].includes(id)
          ? ['members']
          : ['role-menus', 'starboard'].includes(id)
            ? ['messages', 'messageContent', 'reactions']
            : [],
    },
  };
  if (id === 'forms') module.interactions = [{ prefix: 'ob:form:', execute: formInteraction }];
  if (id === 'role-menus')
    module.interactions = [
      {
        prefix: 'ob:role:',
        async execute(interaction, context) {
          if (interaction.isModalSubmit()) return;
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          if (
            !context.store.sqlite
              .prepare(
                "INSERT INTO module_state(module,key,document,updated_at) VALUES('role-menus',?,?,?) ON CONFLICT DO NOTHING",
              )
              .run(
                'interaction:' + interaction.id,
                JSON.stringify({ actor: interaction.user.id }),
                Date.now(),
              ).changes
          )
            throw new HttpError(409, 'Это нажатие уже обработано');
          const [, , id, version, option] = interaction.customId.split(':');
          await community(context).roles.choose(
            id,
            Number(version),
            interaction.user.id,
            interaction.isStringSelectMenu() ? interaction.values : [option],
          );
          await interaction.editReply(notice('Роли обновлены.'));
        },
      },
    ];
  if (id === 'giveaways')
    module.buttons = [
      {
        prefix: 'ob:giveaway:',
        async execute(interaction, context) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const [, , action, id] = interaction.customId.split(':');
          await community(context).giveaways.entry(id, interaction.user.id, action === 'join');
          await interaction.editReply(
            notice(action === 'join' ? 'Вы участвуете.' : 'Вы вышли из розыгрыша.'),
          );
        },
      },
    ];
  if (id === 'guild-backup')
    module.buttons = [
      {
        prefix: 'ob:backup:',
        async execute(interaction, context) {
          const [, , , id, actor] = interaction.customId.split(':');
          if (actor !== interaction.user.id) throw new HttpError(403, 'План другого исполнителя');
          await interaction.deferUpdate();
          await community(context).backup.confirmRestore(id, actor);
          await interaction.editReply(notice('Восстановление поставлено в очередь.'));
        },
      },
    ];
  if (id === 'automod')
    module.buttons = [
      {
        prefix: 'ob:am:',
        async execute(interaction, context) {
          const [, , action, id] = interaction.customId.split(':');
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          await community(context).policies.review(id, interaction.user.id, action === 'warn');
          await interaction.editReply(notice('Решение сохранено.'));
        },
      },
    ];
  return module;
}
