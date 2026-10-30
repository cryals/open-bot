import type { Config } from './config.js';
import type { Store } from './store.js';
import type { DiscordPort } from './discord.js';
import { ModuleStore } from './module-store.js';
import { initialTicketConfig, ticketConfigSchema, type Access } from '../shared/modules.js';
export async function permissions(
  discord: DiscordPort,
  store: Store,
  _config: Config,
  userId: string,
): Promise<Access> {
  const ticket = new ModuleStore(store).get('tickets', ticketConfigSchema, initialTicketConfig).document;
  if (discord.access)
    return discord.access(userId, store.getSettings().adminRoleId, ticket.fullRoleId, ticket.viewRoleId);
  const admin = await discord.authorize(userId, store.getSettings().adminRoleId);
  return { admin, ticketManage: admin, ticketView: admin };
}
