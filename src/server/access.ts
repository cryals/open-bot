import type { Config } from './config.js';
import type { Store } from './store.js';
import type { DiscordPort } from './discord.js';
import { ModuleStore } from './module-store.js';
import { initialTicketConfig, ticketConfigSchema, type Access } from '../shared/modules.js';
import { capabilityNames } from '../shared/settings.js';
import { ApplicationSettingsStore } from './application-settings.js';
import { restPort } from './module-http.js';
import { HttpError } from './errors.js';
import { formsSchema, giveawayConfigSchema } from '../shared/community.js';
export async function permissions(
  discord: DiscordPort,
  store: Store,
  _config: Config,
  userId: string,
): Promise<Access> {
  const ticket = new ModuleStore(store).get('tickets', ticketConfigSchema, initialTicketConfig).document;
  const base = discord.access
    ? await discord.access(
        userId,
        store.getSettings().adminRoleId,
        ticket.fullRoleId || '',
        ticket.viewRoleId || '',
      )
    : await discord
        .authorize(userId, store.getSettings().adminRoleId)
        .then((admin) => ({ admin, ticketManage: admin, ticketView: admin }));
  const grants = new ApplicationSettingsStore(store, _config).get().document.grants;
  const moduleConfigs = new ModuleStore(store),
    forms = moduleConfigs.get('forms', formsSchema, formsSchema.parse({})).document,
    giveaways = moduleConfigs.get('giveaways', giveawayConfigSchema, giveawayConfigSchema.parse({})).document;
  const reviewerRoles = forms.forms.flatMap((form) => form.reviewRoles);
  const needsRoles =
    !base.admin &&
    (Object.values(grants).some((roles) => roles.length) ||
      reviewerRoles.length > 0 ||
      giveaways.managerRoles.length > 0);
  let roles: string[] = [];
  if (needsRoles) {
    try {
      roles = (
        (await restPort(discord).get(`/guilds/${_config.guildId}/members/${userId}`, {
          signal: AbortSignal.timeout(10000),
        })) as { roles: string[] }
      ).roles;
    } catch (error) {
      if ((error as { code?: number }).code !== 10007) throw error;
    }
  }
  const result = {
    ...base,
    ...Object.fromEntries(
      capabilityNames.map((name) => [name, base.admin || grants[name].some((role) => roles.includes(role))]),
    ),
  } as Access;
  result.moderationView ||= result.moderationManage;
  result.formsView ||= result.formsManage;
  result.formReviewer = reviewerRoles.some((role) => roles.includes(role));
  result.giveawaysManage ||= giveaways.enabled && giveaways.managerRoles.some((role) => roles.includes(role));
  return result;
}
export async function requireCapability(
  discord: DiscordPort,
  store: Store,
  config: Config,
  user: string,
  capability: import('../shared/settings.js').Capability,
) {
  if (!(await permissions(discord, store, config, user))[capability])
    throw new HttpError(403, 'Недостаточно полномочий: ' + capability);
}
