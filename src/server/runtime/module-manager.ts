import { MessageFlags, Routes, type Interaction, type CommandInteractionOption } from 'discord.js';
import type { BotCommand, BotContext, BotModule, ModuleSource, ModuleState } from './types.js';
import { notice } from '../render.js';
import { HttpError } from '../errors.js';
import { within } from './deadline.js';

const loggedOptions = (options: readonly CommandInteractionOption[]): unknown[] =>
  options.map((option) => ({
    name: option.name,
    type: option.type,
    value: /token|secret|password|authorization|cookie/i.test(option.name) ? '[REDACTED]' : option.value,
    ...(option.options ? { options: loggedOptions(option.options) } : {}),
  }));

export class ModuleManager {
  private modules = new Map<string, BotModule>();
  private states = new Map<string, ModuleState>();
  private commands = new Map<string, { module: string; command: BotCommand }>();
  private cooldowns = new Map<string, number>();
  private running = new Set<string>();
  private stopping = false;
  constructor(private context: Omit<BotContext, 'manager'>) {}
  get runtime(): BotContext {
    return { ...this.context, manager: this };
  }
  list() {
    return [...this.states.values()];
  }
  definitions() {
    return [...this.modules.values()];
  }
  async load(sources: ModuleSource[]) {
    for (const source of sources) {
      this.states.set(source.id, { id: source.id, title: source.id, state: 'starting' });
      let module: BotModule | undefined;
      try {
        module = (await source.load()).default;
        if (module.id !== source.id || this.modules.has(module.id))
          throw new Error('Module ID mismatch or duplicate: ' + source.id);
        for (const dependency of module.dependencies || [])
          if (this.states.get(dependency)?.state !== 'running')
            throw new Error('Module dependency unavailable: ' + dependency);
        const names = new Set(this.commands.keys());
        for (const command of module.commands || []) {
          command.data.toJSON();
          if (names.has(command.data.name)) throw new Error('Duplicate command: ' + command.data.name);
          names.add(command.data.name);
        }
        const starting = module;
        await within(module.id === 'core' ? 25000 : 10000, async (signal) =>
          starting.start?.(this.runtime, signal),
        );
        this.modules.set(module.id, module);
        for (const command of module.commands || [])
          this.commands.set(command.data.name, { module: module.id, command });
        this.states.set(module.id, { id: module.id, title: module.title, state: 'running' });
        this.context.activity.record(
          { userId: this.context.config.clientId, name: 'Open Space' },
          { kind: 'module.start', target: module.id, summary: 'Запущен модуль ' + module.title },
        );
      } catch (error) {
        const errorId = this.context.errors.report(error, 'module.start', { module: source.id });
        this.states.set(source.id, {
          id: source.id,
          title: module?.title || source.id,
          state: 'failed',
          errorId,
        });
        this.context.activity.record(
          { userId: this.context.config.clientId, name: 'Open Space' },
          {
            kind: 'module.error',
            target: source.id,
            summary: 'Не удалось запустить модуль ' + source.id,
            details: { errorId },
          },
        );
        try {
          const failed = module;
          await within(5000, async (signal) => failed?.stop?.(this.runtime, signal));
        } catch (stopError) {
          this.context.errors.report(stopError, 'module.cleanup', { module: source.id });
        }
      }
    }
  }
  async registerCommands() {
    const body = [...this.commands.values()].map(({ command }) => command.data.toJSON());
    await this.context.discord.rest.put(
      Routes.applicationGuildCommands(this.context.config.clientId, this.context.config.guildId),
      { body, signal: AbortSignal.timeout(15000) },
    );
    console.info(
      JSON.stringify({ kind: 'commands.registered', commands: body.map((command) => command.name) }),
    );
  }
  async dispatch(interaction: Interaction) {
    if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
    if (this.stopping) return;
    if (interaction.guildId !== this.context.config.guildId) return;
    const actor = { userId: interaction.user.id, name: interaction.user.username };
    const target = interaction.isChatInputCommand() ? '/' + interaction.commandName : interaction.customId;
    let scope = 'interaction';
    try {
      if (interaction.isChatInputCommand()) {
        const started = Date.now();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const ackMs = Date.now() - started;
        const entry = this.commands.get(interaction.commandName);
        if (!entry) throw new HttpError(404, 'Команда недоступна. Откройте /help.');
        scope = entry.module + '.command.' + interaction.commandName;
        if (
          entry.command.admin &&
          !(await this.context.discord.authorize(actor.userId, this.context.store.getSettings().adminRoleId))
        )
          throw new HttpError(403, 'Эта команда доступна только администрации.');
        const key = actor.userId + ':' + interaction.commandName;
        if ((this.cooldowns.get(key) || 0) > Date.now() || this.running.has(key))
          throw new HttpError(
            429,
            'Команда уже выполняется или вызвана слишком часто. Подождите несколько секунд.',
          );
        this.cooldowns.set(key, Date.now() + 2000);
        if (this.cooldowns.size > 1000)
          for (const [key, until] of this.cooldowns) if (until < Date.now()) this.cooldowns.delete(key);
        this.running.add(key);
        this.context.activity.record(actor, {
          kind: 'bot.command',
          target,
          summary: 'Выполнена команда ' + target,
          details: {
            interactionId: interaction.id,
            channelId: interaction.channelId,
            options: loggedOptions(interaction.options.data),
          },
        });
        try {
          await within(45000, (signal) =>
            entry.command.execute({ interaction, ackMs, signal }, this.runtime),
          );
        } finally {
          this.running.delete(key);
        }
      } else {
        const handler = this.definitions()
          .flatMap((module) => (module.buttons || []).map((button) => ({ module: module.id, ...button })))
          .find((button) => interaction.customId.startsWith(button.prefix));
        if (!handler) return;
        scope = handler.module + '.button';
        const receivedAt = Date.now();
        try {
          await handler.execute(interaction, this.runtime);
        } finally {
          this.context.activity.record(actor, {
            kind: 'bot.button',
            target,
            summary:
              'Нажата кнопка бота: ' +
              (('label' in interaction.component && interaction.component.label) || target),
            details: {
              channelId: interaction.channelId,
              messageId: interaction.message.id,
              occurredAt: receivedAt,
            },
          });
        }
      }
    } catch (error) {
      const expected = error instanceof HttpError && error.statusCode < 500;
      const errorId = expected
        ? undefined
        : this.context.errors.report(error, scope, {
            actor: actor.userId,
            channelId: interaction.channelId,
            interactionId: interaction.id,
            target,
          });
      this.context.activity.record(actor, {
        kind: 'bot.error',
        target,
        summary: 'Действие бота завершилось ошибкой',
        details: { errorId, error: error instanceof Error ? error.name : 'Error' },
      });
      const payload = notice(
        expected ? error.message : 'Не удалось выполнить действие. Попробуйте ещё раз. ID ошибки: ' + errorId,
      );
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
        else
          await interaction.reply({
            ...payload,
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          });
      } catch (replyError) {
        this.context.errors.report(replyError, scope + '.reply', { interactionId: interaction.id, errorId });
      }
    }
  }
  async stop() {
    this.stopping = true;
    for (const module of this.definitions().reverse()) {
      try {
        await within(5000, async (signal) => module.stop?.(this.runtime, signal));
      } catch (error) {
        this.context.errors.report(error, 'module.stop', { module: module.id });
      }
    }
  }
}
