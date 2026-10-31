import type { BotModule } from '../../runtime/types.js';
import { community } from '../../community-runtime.js';
const module: BotModule = {
  id: 'community',
  title: 'Community Core',
  description: 'Общий порядок событий и сохраняемые задания модулей.',
  dependencies: ['moderation'],
  async start(context) {
    await community(context).start();
  },
  async stop(context) {
    await community(context).stop();
  },
};
export default module;
