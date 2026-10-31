import type { BotModule } from '../../runtime/types.js';
import { ModerationLogService } from './service.js';
let timer: ReturnType<typeof setInterval> | undefined;
let handler: ((event: { t?: string; d?: Record<string, unknown> }) => void) | undefined;
const module: BotModule = {
  id: 'moderation-logs',
  title: 'Moderation Logs',
  description: 'Карточки наказаний с отдельной сохраняемой доставкой.',
  dependencies: ['moderation'],
  requirements: { intents: ['moderation'], events: ['GUILD_AUDIT_LOG_ENTRY_CREATE'] },
  async start(context) {
    const service = new ModerationLogService(context.config, context.store, context.discord, (error, scope) =>
      context.errors.report(error, scope),
    );
    timer = setInterval(
      () => void service.tick().catch((error) => context.errors.report(error, 'moderation-log.tick')),
      2000,
    );
    timer.unref();
    handler = (event) => {
      try {
        service.external(event);
      } catch (error) {
        context.errors.report(error, 'moderation-log.audit');
      }
    };
    context.discord.client.on('raw', handler);
  },
  async stop(context) {
    clearInterval(timer);
    if (handler) context.discord.client.off('raw', handler);
  },
};
export default module;
