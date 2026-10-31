import { moduleIntents, modulePermissions, saveCommunityConfiguration } from './community-config.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { communityDefinitions, communityJobModules, type CommunityModuleId } from '../shared/community.js';
import type { ModuleContext } from './runtime/types.js';
import { CommunityStore } from './community-store.js';
import { requireCapability } from './access.js';
import { JobStore } from './jobs.js';
import { HttpError } from './errors.js';
import { GiveawayService } from './modules/giveaways/service.js';
import { FormService } from './modules/forms/service.js';
import { GuildBackupService } from './modules/guild-backup/service.js';
import { ApplicationSettingsStore } from './application-settings.js';
import { GuildAuthority } from './authority.js';
import { PermissionFlagsBits as P } from 'discord.js';
import { uiEventSchema } from '../shared/activity.js';
import { ModerationService } from './modules/moderation/service.js';
const moduleId = z.enum(Object.keys(communityDefinitions) as [CommunityModuleId, ...CommunityModuleId[]]);
const versioned = z.object({ document: z.unknown(), version: z.number().int().min(0) });
export function communityRoutes(app: FastifyInstance, context: ModuleContext) {
  const { store, discord, config, activity } = context,
    configs = new CommunityStore(store),
    forms = new FormService(context),
    giveaways = new GiveawayService(context),
    backup = new GuildBackupService(context);
  const actor = (request: FastifyRequest) => request.adminSession!;
  const guard = async (request: FastifyRequest, id: CommunityModuleId) =>
    requireCapability(discord, store, config, actor(request).userId, communityDefinitions[id].capability);
  const queue = (request: FastifyRequest, kind: string, payload: unknown) => {
    const id = randomUUID();
    new JobStore(store).enqueue(id, 'community.' + kind, id, {
      ...(payload as object),
      actor: actor(request).userId,
    });
    activity.record(actor(request), {
      kind: 'community.request',
      target: kind,
      summary: 'Запрошено действие ' + kind,
      details: { operationId: id },
    });
    return { id };
  };
  app.get('/api/community', async (request) =>
    Object.entries(communityDefinitions)
      .filter(([, value]) => request.adminAccess[value.capability])
      .map(([id, value]) => ({
        id,
        title: value.title,
        capability: value.capability,
        intents: moduleIntents[id as CommunityModuleId] || [],
      })),
  );
  app.get('/api/community/guild', async (request) => {
    if (
      !request.adminAccess.admin &&
      !Object.values(communityDefinitions).some((definition) => request.adminAccess[definition.capability])
    )
      throw new HttpError(403, 'Нет доступа к модулям сообщества');
    return discord.info();
  });
  app.post(
    '/api/community/activity',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request) => {
      if (
        !request.adminAccess.admin &&
        !Object.values(communityDefinitions).some(
          (definition) => request.adminAccess[definition.capability],
        ) &&
        !request.adminAccess.formsView &&
        !request.adminAccess.formReviewer
      )
        throw new HttpError(403, 'Нет доступа');
      const { events } = z.object({ events: z.array(uiEventSchema).min(1).max(20) }).parse(request.body);
      for (const event of events)
        activity.record(actor(request), {
          ...event,
          target: 'community-ui:' + event.target,
          details: { source: 'browser', context: event.context, occurredAt: event.occurredAt },
        });
      return { ok: true };
    },
  );
  app.get('/api/community/jobs', async (request) => {
    const allowed = Object.entries(communityDefinitions)
      .filter(([, value]) => request.adminAccess[value.capability])
      .map(([id]) => id);
    return store.sqlite
      .prepare(
        "SELECT id,kind,state,due_at,result,attempts FROM core_jobs WHERE kind LIKE 'community.%' ORDER BY created_at DESC LIMIT 100",
      )
      .all()
      .filter(
        (row) =>
          request.adminAccess.admin || allowed.includes(communityJobModules[(row as { kind: string }).kind]),
      );
  });
  app.get('/api/community/config/:id', async (request) => {
    const { id } = z.object({ id: moduleId }).parse(request.params);
    await guard(request, id);
    const value = configs.config(id);
    const actual = await new GuildAuthority(config, discord, store).load(actor(request).userId);
    return {
      ...value,
      schema: z.toJSONSchema(communityDefinitions[id].schema, { unrepresentable: 'any', target: 'draft-7' }),
      requiredIntents: moduleIntents[id] || [],
      missingPermissions: modulePermissions[id]
        .filter((permission) => !actual.has(actual.bot, permission))
        .map(
          (permission) =>
            Object.entries(P).find(([, value]) => value === permission)?.[0] || String(permission),
        ),
      appliedGateway: new ApplicationSettingsStore(store, config).appliedGateway(),
    };
  });
  app.put('/api/community/config/:id', async (request) => {
    const { id } = z.object({ id: moduleId }).parse(request.params);
    const input = versioned.parse(request.body);
    return saveCommunityConfiguration(context, id, input.document, input.version, actor(request));
  });
  app.get('/api/community/state/:id', async (request) => {
    const { id } = z.object({ id: moduleId }).parse(request.params);
    await guard(request, id);
    return store.sqlite
      .prepare(
        "SELECT key,CASE WHEN key='phishing-feed' THEN json_object('domains',json_array_length(json_extract(document,'$.domains')),'updatedAt',json_extract(document,'$.updatedAt')) ELSE document END document,updated_at FROM module_state WHERE module=? AND key NOT LIKE 'draft:%' ORDER BY updated_at DESC LIMIT 100",
      )
      .all(id);
  });
  app.get('/api/community/evidence', async (request) => {
    await guard(request, 'automod');
    return store.sqlite
      .prepare('SELECT * FROM automod_evidence WHERE expires_at>? ORDER BY created_at DESC LIMIT 100')
      .all(Date.now());
  });
  app.post('/api/community/automod/sync', async (request) => {
    await guard(request, 'automod');
    return queue(request, 'native-sync', {});
  });
  app.post('/api/community/evidence/:id/undo', async (request) => {
    await guard(request, 'automod');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { reason } = z.object({ reason: z.string().trim().min(1).max(1000) }).parse(request.body);
    const evidence = store.sqlite
      .prepare('SELECT case_id FROM automod_evidence WHERE id=? AND expires_at>?')
      .get(id, Date.now()) as { case_id: number | null } | undefined;
    if (!evidence?.case_id)
      throw new HttpError(
        409,
        'Нет обратимой санкции: удалённое сообщение или исключение участника восстановить нельзя',
      );
    const service = new ModerationService(config, store, discord, activity),
      row = service.get(evidence.case_id);
    if (row.action === 'warn')
      return service.change(row.id, actor(request), { reason, revision: row.revision, revoke: true });
    const action = ({ timeout: 'untimeout', ban: 'unban', tempban: 'unban', 'role-mute': 'unmute' } as const)[
      row.action as 'timeout' | 'ban' | 'tempban' | 'role-mute'
    ];
    if (!action || row.state !== 'applied')
      throw new HttpError(409, 'Это действие нельзя отменить автоматически');
    const active = store.sqlite
      .prepare('SELECT case_id FROM moderation_active WHERE target=? AND kind=?')
      .get(row.target, row.action === 'tempban' ? 'ban' : row.action) as { case_id: number } | undefined;
    if (active?.case_id !== row.id)
      throw new HttpError(409, 'Санкция заменена другим делом; откройте актуальное дело');
    return service.prepare(
      { operationId: randomUUID(), action, target: row.target, reason, duration: null, deleteSeconds: 0 },
      actor(request),
      'automod-undo:' + row.id,
    );
  });
  app.post('/api/community/roles/:id/publish', async (request) => {
    await guard(request, 'role-menus');
    const { id } = z.object({ id: z.string().max(40) }).parse(request.params);
    return queue(request, 'role-panel', { id });
  });
  app.post('/api/community/roles/:id/disable', async (request) => {
    await guard(request, 'role-menus');
    const { id } = z.object({ id: z.string().max(40) }).parse(request.params);
    store.sqlite.prepare('UPDATE role_panels SET enabled=0 WHERE id=?').run(id);
    return { ok: true };
  });
  app.post('/api/community/raid/:action', async (request) => {
    await guard(request, 'anti-raid');
    const { action } = z.object({ action: z.enum(['start', 'stop']) }).parse(request.params),
      { reason } = z.object({ reason: z.string().min(1).max(300) }).parse(request.body);
    return queue(request, 'raid-' + action, { reason });
  });
  app.get('/api/community/forms', async (request) => forms.list(actor(request).userId));
  app.get('/api/community/forms/:id', async (request) =>
    forms.view(
      z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id,
      actor(request).userId,
    ),
  );
  app.post('/api/community/forms/:id/review', async (request) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params),
      input = z
        .object({
          state: z.enum(['pending', 'processing', 'accepted', 'rejected']),
          comment: z.string().max(1000),
        })
        .parse(request.body);
    return forms.review(id, actor(request).userId, input.state, input.comment);
  });
  app.get('/api/community/giveaways', async (request) => {
    await guard(request, 'giveaways');
    return giveaways.list();
  });
  app.post('/api/community/giveaways', async (request) => {
    await guard(request, 'giveaways');
    return giveaways.create(request.body, actor(request).userId);
  });
  app.post('/api/community/giveaways/:id/:action', async (request) => {
    await guard(request, 'giveaways');
    const { id, action } = z
        .object({ id: z.string().uuid(), action: z.enum(['end', 'cancel', 'reroll']) })
        .parse(request.params),
      { reason } = z.object({ reason: z.string().min(1).max(1000) }).parse(request.body);
    return queue(request, 'giveaway-' + action, { id, actor: actor(request).userId, reason });
  });
  app.post('/api/community/starboard/hide', async (request) => {
    await guard(request, 'starboard');
    const value = z
      .object({ board: z.string().max(40), id: z.string().regex(/^\d{17,20}$/) })
      .parse(request.body);
    return queue(request, 'star-hide', value);
  });
  app.get('/api/community/feeds', async (request) => {
    await guard(request, 'subscriptions');
    return {
      sources: store.sqlite.prepare('SELECT * FROM feed_sources').all(),
      delivery: store.sqlite.prepare('SELECT * FROM feed_delivery ORDER BY rowid DESC LIMIT 100').all(),
    };
  });
  app.post('/api/community/feeds/resolve', async (request) => {
    await guard(request, 'subscriptions');
    const input = z
      .object({
        feed: z.string().max(40),
        content: z.string().max(300),
        messageId: z
          .string()
          .regex(/^\d{17,20}$/)
          .nullable(),
      })
      .parse(request.body);
    const row = store.sqlite
      .prepare("SELECT channel_id FROM feed_delivery WHERE feed_id=? AND content_id=? AND state='unknown'")
      .get(input.feed, input.content) as { channel_id: string } | undefined;
    if (!row) throw new HttpError(404, 'Неопределённая доставка не найдена');
    if (input.messageId) {
      const message = (await import('./module-http.js').then(({ restPort }) =>
        restPort(discord).get(`/channels/${row.channel_id}/messages/${input.messageId}`, {
          signal: AbortSignal.timeout(10000),
        }),
      )) as { author: { id: string } };
      if (message.author.id !== config.clientId) throw new HttpError(403, 'Сообщение другого автора');
    }
    store.sqlite
      .prepare('UPDATE feed_delivery SET state=?,message_id=?,error=NULL WHERE feed_id=? AND content_id=?')
      .run(input.messageId ? 'sent' : 'pending', input.messageId, input.feed, input.content);
    return { ok: true };
  });
  app.get('/api/community/backups', async (request) => {
    await guard(request, 'guild-backup');
    return { backups: backup.list(), restores: backup.restores() };
  });
  app.post('/api/community/backups', async (request) => {
    await guard(request, 'guild-backup');
    return backup.queue(actor(request).userId);
  });
  app.get('/api/community/backups/:id/download', async (request, reply) => {
    await guard(request, 'guild-backup');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return reply
      .type('application/gzip')
      .header('Content-Disposition', `attachment; filename="open-bot-guild-${id}.json.gz"`)
      .send(await backup.artifact(id));
  });
  app.post('/api/community/backups/import', { bodyLimit: 150 * 1024 * 1024 }, async (request) => {
    await guard(request, 'guild-backup');
    const { data } = z.object({ data: z.string().max(150 * 1024 * 1024) }).parse(request.body);
    return backup.import(Buffer.from(data, 'base64'));
  });
  app.post('/api/community/backups/:id/restore', async (request) => {
    await guard(request, 'guild-backup');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return backup.prepareRestore(id, actor(request).userId, request.body);
  });
  app.post('/api/community/restores/:id/:action', async (request) => {
    await guard(request, 'guild-backup');
    const { id, action } = z
      .object({ id: z.string().uuid(), action: z.enum(['confirm', 'resume', 'cancel', 'resolve']) })
      .parse(request.params);
    if (action === 'confirm') return backup.confirmRestore(id, actor(request).userId);
    if (action === 'resume') return backup.resume(id, actor(request).userId);
    if (action === 'resolve') {
      const input = z
        .object({ kind: z.string().max(80), source: z.string().max(100), newId: z.string().nullable() })
        .parse(request.body);
      return backup.resolveStep(id, input.kind, input.source, input.newId, actor(request).userId);
    }
    backup.cancel(id);
    return { ok: true };
  });
  app.get('/api/community/restores/:id', async (request) => {
    await guard(request, 'guild-backup');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return {
      restore: backup.restore(id),
      steps: store.sqlite.prepare('SELECT * FROM guild_restore_steps WHERE restore_id=?').all(id),
    };
  });
  app.post('/api/community/slowmode', async (request) => {
    await guard(request, 'slowmode');
    const input = z
      .object({
        channelId: z.string().regex(/^\d{17,20}$/),
        mode: z.enum(['discord', 'user', 'channel', 'off']),
        seconds: z.number().int().min(0).max(21600),
        duration: z.number().int().min(1).max(2592000).optional(),
      })
      .parse(request.body);
    await new GuildAuthority(config, discord, store).channel(
      actor(request).userId,
      input.channelId,
      P.ManageChannels,
    );
    const current = configs.config('slowmode'),
      rules = current.document.rules.filter((rule) => rule.channelId !== input.channelId);
    if (input.mode !== 'off')
      rules.push({
        id: randomUUID(),
        channelId: input.channelId,
        mode: input.mode,
        seconds: Math.max(1, input.seconds),
        expiresAt: input.duration ? Date.now() + input.duration * 1000 : null,
        exceptRoles: [],
      });
    return saveCommunityConfiguration(
      context,
      'slowmode',
      { enabled: true, rules },
      current.version,
      actor(request),
    );
  });
}
