import { randomInt } from 'node:crypto';
import { SlashCommandBuilder, PermissionFlagsBits, type ChatInputCommandInteraction } from 'discord.js';
import type { ModuleContext, BotCommand } from '../../runtime/types.js';
import { CommunityStore } from '../../community-store.js';
import { TtlCounters } from '../../ttl-counters.js';
import { HttpError } from '../../errors.js';
import { currentMember } from '../anti-raid/service.js';
import { sendBlocks } from '../../module-discord.js';
import { renderTemplate } from '../../template-context.js';
import { GuildAuthority } from '../../authority.js';
import { restPort } from '../../module-http.js';
import { notice } from '../../render.js';
import { FormService } from '../forms/service.js';
import { TicketService } from '../ticket/service.js';
import { JobStore } from '../../jobs.js';
export class CustomCommandService {
  private configs: CommunityStore;
  constructor(
    private context: ModuleContext,
    private counters: TtlCounters,
  ) {
    this.configs = new CommunityStore(context.store);
  }
  definitions(): BotCommand[] {
    const config = this.configs.config('custom-commands').document;
    if (!config.enabled) return [];
    return config.commands
      .filter((command) => command.enabled && command.registerSlash)
      .map((command) => {
        const data = new SlashCommandBuilder().setName(command.name).setDescription(command.description);
        for (const arg of [...command.arguments].sort((a, b) => Number(b.required) - Number(a.required))) {
          if (arg.type === 'integer')
            data.addIntegerOption((option) =>
              option.setName(arg.name).setDescription(arg.description).setRequired(arg.required),
            );
          else if (arg.type === 'user')
            data.addUserOption((option) =>
              option.setName(arg.name).setDescription(arg.description).setRequired(arg.required),
            );
          else if (arg.type === 'channel')
            data.addChannelOption((option) =>
              option.setName(arg.name).setDescription(arg.description).setRequired(arg.required),
            );
          else if (arg.type === 'role')
            data.addRoleOption((option) =>
              option.setName(arg.name).setDescription(arg.description).setRequired(arg.required),
            );
          else
            data.addStringOption((option) =>
              option.setName(arg.name).setDescription(arg.description).setRequired(arg.required),
            );
        }
        return {
          data,
          execute: async ({ interaction }) => {
            const args: Record<string, string | number> = {};
            for (const arg of command.arguments) {
              const option = interaction.options.get(arg.name);
              if (option?.value !== undefined) args[arg.name] = option.value as string | number;
            }
            await this.run(command.id, interaction, args);
          },
        };
      });
  }
  async run(
    id: string,
    interaction: ChatInputCommandInteraction,
    args: Record<string, string | number> = {},
  ) {
    const config = this.configs.config('custom-commands', true).document,
      command = config.commands.find((command) => command.id === id && command.enabled);
    if (!config.enabled || !command) throw new HttpError(404, 'Команда выключена');
    const member = await currentMember(this.context, interaction.user.id);
    if (
      (command.roles.length && !command.roles.some((role) => member.roles.includes(role))) ||
      (command.channels.length && !command.channels.includes(interaction.channelId || ''))
    )
      throw new HttpError(403, 'Команда недоступна в этом канале или для вашей роли');
    for (const arg of command.arguments) {
      const value = args[arg.name];
      if (value === undefined) {
        if (arg.required) throw new HttpError(400, 'Отсутствует аргумент: ' + arg.name);
        continue;
      }
      if (arg.type === 'integer' && !Number.isSafeInteger(value))
        throw new HttpError(400, 'Аргумент должен быть целым числом');
      if (['user', 'channel', 'role'].includes(arg.type) && !/^\d{17,20}$/.test(String(value)))
        throw new HttpError(400, 'Ожидается ID Discord');
      if (String(value).length > 1000) throw new HttpError(400, 'Аргумент слишком длинный');
    }
    if (Object.keys(args).some((key) => !command.arguments.some((arg) => arg.name === key)))
      throw new HttpError(400, 'Неизвестный аргумент');
    if (
      command.cooldown &&
      !(await this.counters.once(`custom:${command.id}:${interaction.user.id}`, command.cooldown * 1000))
    )
      throw new HttpError(429, 'Подождите перед следующим вызовом');
    const context = {
      user: interaction.user.username,
      userId: interaction.user.id,
      guild: this.context.config.guildId,
      channel: interaction.channelId || '',
      ...Object.fromEntries(command.arguments.map((arg) => ['arg.' + arg.name, args[arg.name] ?? ''])),
    };
    const blocks = renderTemplate(command.responses[randomInt(command.responses.length)], context);
    if (command.private) {
      const { customMessage } = await import('../../blocks.js');
      await interaction.editReply(
        customMessage({
          id: 'custom',
          blocks,
          silent: command.delivery.silent,
          mentions: command.delivery.mentions,
        }),
      );
      if (command.deleteAfter) {
        const timer = setTimeout(
          () =>
            void interaction
              .deleteReply()
              .catch((error) => this.context.errors.report(error, 'custom.expiry')),
          Math.min(command.deleteAfter, 840) * 1000,
        );
        timer.unref();
      }
    } else {
      const id = await sendBlocks(
        this.context.discord,
        this.context.store,
        interaction.channelId!,
        blocks,
        [],
        `custom:${interaction.id}`,
        undefined,
        undefined,
        command.delivery,
      );
      await interaction.editReply(notice('Сообщение отправлено.'));
      if (command.deleteAfter)
        new JobStore(this.context.store).enqueue(
          'delete:' + id,
          'community.delete',
          interaction.id,
          { channel: interaction.channelId, id },
          Date.now() + command.deleteAfter * 1000,
        );
    }
    for (const action of command.actions) {
      if (action.requiredRole && !member.roles.includes(action.requiredRole)) continue;
      if (action.type === 'role-add' || action.type === 'role-remove')
        await new GuildAuthority(this.context.config, this.context.discord, this.context.store).safeRole(
          this.context.config.clientId,
          interaction.user.id,
          action.value,
          command.safeRoles,
          action.type === 'role-add',
        );
      else if (action.type === 'dm') {
        const dm = (await restPort(this.context.discord).post('/users/@me/channels', {
          body: { recipient_id: interaction.user.id },
          signal: AbortSignal.timeout(10000),
        })) as { id: string };
        await sendBlocks(
          this.context.discord,
          this.context.store,
          dm.id,
          blocks,
          [],
          `custom-dm:${interaction.id}`,
          undefined,
          undefined,
          command.delivery,
        );
      } else if (action.type === 'send') {
        await new GuildAuthority(this.context.config, this.context.discord, this.context.store).channel(
          interaction.user.id,
          action.value,
          PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages,
        );
        await sendBlocks(
          this.context.discord,
          this.context.store,
          action.value,
          blocks,
          [],
          `custom-send:${interaction.id}`,
          undefined,
          undefined,
          command.delivery,
        );
      } else if (action.type === 'form') {
        const draft = await new FormService(this.context).open(action.value, interaction.user.id);
        await interaction.followUp({
          ...notice(`Форма: ${this.context.config.appOrigin}/forms/${draft.definition.id}`),
          flags: 32768 | 64,
        });
      } else if (action.type === 'ticket')
        new TicketService(
          this.context.config,
          this.context.store,
          this.context.discord,
          this.context.activity,
          (error, scope) => this.context.errors.report(error, scope),
        ).reserve(interaction.user.id, action.value);
    }
  }
}
