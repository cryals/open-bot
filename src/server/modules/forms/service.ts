import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { formSchema, formsSchema } from '../../../shared/community.js';
import { ModuleStore } from '../../module-store.js';
import type { ModuleContext } from '../../runtime/types.js';
import { CommunityStore } from '../../community-store.js';
import { HttpError } from '../../errors.js';
import { restPort } from '../../module-http.js';
import { sendBlocks } from '../../module-discord.js';
import { currentMember } from '../anti-raid/service.js';
import { GuildAuthority } from '../../authority.js';
import { TicketService } from '../ticket/service.js';
type Definition = z.infer<typeof formSchema>;
export type Submission = {
  id: number;
  form_id: string;
  user_id: string;
  form_version: number;
  definition: string;
  answers: string;
  state: string;
  assignee: string | null;
  decision: string | null;
  case_id: number | null;
  message_id: string | null;
  thread_id: string | null;
  created_at: number;
  expires_at: number;
  delivery_state: string;
};
export type FormDraft = {
  id: string;
  user: string;
  definition: Definition;
  version: number;
  answers: Record<string, string | string[]>;
  step: number;
  created: number;
  caseId?: number;
};
export class FormService {
  private configs: CommunityStore;
  constructor(private context: ModuleContext) {
    this.configs = new CommunityStore(context.store);
  }
  definition(id: string) {
    const config = this.configs.config('forms', true);
    if (!config.document.enabled) throw new HttpError(409, 'Формы выключены');
    const form = config.document.forms.find((form) => form.id === id && form.enabled);
    if (!form) throw new HttpError(404, 'Форма не найдена');
    return { form, version: config.version };
  }
  async available(form: Definition, user: string) {
    if ((form.opensAt && Date.now() < form.opensAt) || (form.closesAt && Date.now() >= form.closesAt))
      throw new HttpError(409, 'Приём заявок закрыт');
    if (form.membersOnly || form.roles.length) {
      let member;
      try {
        member = await currentMember(this.context, user);
      } catch (error) {
        if ((error as { code?: number }).code === 10007)
          throw new HttpError(403, 'Форма доступна только участникам сервера');
        throw error;
      }
      if (form.roles.length && !form.roles.some((role) => member.roles.includes(role)))
        throw new HttpError(403, 'Нет роли доступа к форме');
    }
    const existing = this.context.store.sqlite
      .prepare(
        'SELECT created_at FROM form_submissions WHERE form_id=? AND user_id=? ORDER BY id DESC LIMIT 1',
      )
      .get(form.id, user) as { created_at: number } | undefined;
    if (existing && (form.onePerUser || Date.now() - existing.created_at < form.cooldown * 1000))
      throw new HttpError(409, 'Заявка уже отправлена или действует cooldown');
  }
  async open(id: string, user: string, caseId?: number) {
    const { form, version } = this.definition(id);
    await this.available(form, user);
    const draft: FormDraft = {
      id: randomUUID(),
      user,
      definition: form,
      version,
      answers: {},
      step: 0,
      created: Date.now(),
      caseId,
    };
    this.configs.set('forms', 'draft:' + draft.id, draft);
    return draft;
  }
  draft(id: string, user: string) {
    const draft = this.configs.state<FormDraft>('forms', 'draft:' + id);
    if (!draft || draft.user !== user || Date.now() - draft.created > 3600000)
      throw new HttpError(404, 'Заполнение устарело; откройте форму заново');
    if (this.definition(draft.definition.id).version !== draft.version)
      throw new HttpError(409, 'Форма изменилась. Откройте её заново.');
    return draft;
  }
  answer(id: string, user: string, answers: Record<string, string | string[]>) {
    const draft = this.draft(id, user);
    for (const [key, value] of Object.entries(answers)) {
      if (!draft.definition.questions.some((question) => question.id === key))
        throw new HttpError(400, 'Неизвестный вопрос');
      draft.answers[key] = value;
    }
    this.configs.set('forms', 'draft:' + id, draft);
    return draft;
  }
  async submit(id: string, user: string, input?: unknown) {
    const draft = this.draft(id, user),
      form = draft.definition;
    await this.available(form, user);
    const answers = z
      .record(z.string(), z.union([z.string().max(20000), z.array(z.string().max(100)).max(25)]))
      .parse(input || draft.answers);
    for (const question of form.questions) {
      const value = answers[question.id];
      if (question.required && (!value || (typeof value === 'string' ? !value.trim() : !value.length)))
        throw new HttpError(400, 'Заполните: ' + question.label);
      if (value && ['single', 'multiple'].includes(question.type)) {
        const selected = Array.isArray(value) ? value : [value];
        if (
          (question.type === 'single' && selected.length > 1) ||
          selected.some((item) => !question.choices.includes(item))
        )
          throw new HttpError(400, 'Недопустимый вариант ответа');
      }
      if (value && question.type === 'short' && String(value).length > 1000)
        throw new HttpError(400, 'Короткий ответ слишком длинный');
    }
    if (Object.keys(answers).some((key) => !form.questions.some((question) => question.id === key)))
      throw new HttpError(400, 'Неизвестное поле');
    if (draft.caseId) {
      const row = this.context.store.sqlite
        .prepare('SELECT target FROM moderation_cases WHERE id=?')
        .get(draft.caseId) as { target: string } | undefined;
      if (!form.appeal || row?.target !== user) throw new HttpError(403, 'Дело не принадлежит заявителю');
    }
    return this.context.store.sqlite
      .transaction(() => {
        const existing = this.context.store.sqlite
          .prepare(
            'SELECT created_at FROM form_submissions WHERE form_id=? AND user_id=? ORDER BY id DESC LIMIT 1',
          )
          .get(form.id, user) as { created_at: number } | undefined;
        if (existing && (form.onePerUser || Date.now() - existing.created_at < form.cooldown * 1000))
          throw new HttpError(409, 'Заявка уже отправлена');
        const result = this.context.store.sqlite
          .prepare(
            'INSERT INTO form_submissions(form_id,user_id,form_version,definition,answers,case_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)',
          )
          .run(
            form.id,
            user,
            draft.version,
            JSON.stringify(form),
            JSON.stringify(answers),
            draft.caseId || null,
            Date.now(),
            Date.now() + form.retentionDays * 86400000,
          );
        this.context.store.sqlite
          .prepare("DELETE FROM module_state WHERE module='forms' AND key=?")
          .run('draft:' + id);
        return { id: Number(result.lastInsertRowid) };
      })
      .immediate();
  }
  get(id: number) {
    const row = this.context.store.sqlite
      .prepare('SELECT * FROM form_submissions WHERE id=? AND expires_at>?')
      .get(id, Date.now()) as Submission | undefined;
    if (!row) throw new HttpError(404, 'Заявка не найдена');
    return row;
  }
  private async reviewer(user: string) {
    const { permissions } = await import('../../access.js');
    const access = await permissions(this.context.discord, this.context.store, this.context.config, user);
    const member = access.formReviewer ? await currentMember(this.context, user) : null;
    const current = new ModuleStore(this.context.store).get(
      'forms',
      formsSchema,
      formsSchema.parse({}),
    ).document;
    return {
      viewAll: !!(access.admin || access.formsManage || access.formsView),
      manageAll: !!(access.admin || access.formsManage),
      roles: member?.roles || [],
      forms: current.forms,
    };
  }
  private present(row: Submission, reviewer: Awaited<ReturnType<FormService['reviewer']>>) {
    const current = reviewer.forms.find((form) => form.id === row.form_id),
      assigned = !!current?.reviewRoles.some((role) => reviewer.roles.includes(role));
    if (!reviewer.viewAll && !assigned) return null;
    const form = formSchema.parse(JSON.parse(row.definition));
    return {
      ...row,
      user_id: form.anonymous ? 'скрыт' : row.user_id,
      case_id: form.anonymous ? null : row.case_id,
      canProcess: reviewer.manageAll || assigned,
    };
  }
  async view(id: number, user: string) {
    const row = this.get(id);
    const result = this.present(row, await this.reviewer(user));
    if (!result) throw new HttpError(403, 'Нет доступа к заявке');
    return result;
  }
  async list(user: string) {
    const rows = this.context.store.sqlite
      .prepare('SELECT * FROM form_submissions WHERE expires_at>? ORDER BY id DESC LIMIT 100')
      .all(Date.now()) as Submission[];
    const reviewer = await this.reviewer(user);
    return rows.map((row) => this.present(row, reviewer)).filter((row) => row !== null);
  }
  async review(id: number, user: string, state: string, comment: string) {
    const row = this.get(id);
    const reviewer = await this.reviewer(user),
      projection = this.present(row, reviewer);
    if (!projection?.canProcess) throw new HttpError(403, 'Нет доступа к обработке заявки');
    if (!['pending', 'accepted', 'rejected', 'processing'].includes(state))
      throw new HttpError(400, 'Неизвестное состояние');
    this.context.store.sqlite
      .prepare(
        "UPDATE form_submissions SET state=?,assignee=?,decision=?,delivery_state='pending' WHERE id=?",
      )
      .run(state, user, comment, id);
    this.context.activity.record(
      { userId: user, name: user },
      { kind: 'form.decision', target: String(id), summary: 'Обработана заявка', details: { state } },
    );
    return this.present(this.get(id), reviewer);
  }
  async tick() {
    const rest = restPort(this.context.discord);
    const expired = this.context.store.sqlite
      .prepare('SELECT * FROM form_submissions WHERE expires_at<=? LIMIT 20')
      .all(Date.now()) as Submission[];
    for (const row of expired) {
      const form = formSchema.parse(JSON.parse(row.definition));
      if (row.thread_id)
        await rest
          .delete(`/channels/${row.thread_id}`, { signal: AbortSignal.timeout(10000) })
          .catch((error) => {
            if ((error as { code?: number }).code !== 10003) throw error;
          });
      const messages = this.configs.state<string[]>('forms', 'messages:' + row.id) || [];
      for (const id of messages)
        await rest
          .delete(`/channels/${form.channelId}/messages/${id}`, { signal: AbortSignal.timeout(10000) })
          .catch((error) => {
            if ((error as { code?: number }).code !== 10008) throw error;
          });
      this.context.store.sqlite
        .transaction(() => {
          this.context.store.sqlite.prepare('DELETE FROM form_submissions WHERE id=?').run(row.id);
          this.context.store.sqlite
            .prepare("DELETE FROM module_state WHERE module='forms' AND key=?")
            .run('messages:' + row.id);
        })
        .immediate();
    }
    this.context.store.sqlite
      .prepare("DELETE FROM module_state WHERE module='forms' AND key LIKE 'draft:%' AND updated_at<?")
      .run(Date.now() - 3600000);
    const rows = this.context.store.sqlite
      .prepare(
        "SELECT * FROM form_submissions WHERE delivery_state='pending' AND expires_at>? ORDER BY id LIMIT 10",
      )
      .all(Date.now()) as Submission[];
    for (const row of rows) {
      const form = formSchema.parse(JSON.parse(row.definition)),
        answers = JSON.parse(row.answers) as Record<string, string | string[]>;
      const text =
        `## ${form.title} · Заявка #${row.id}\nАвтор: ${form.anonymous ? 'скрыт' : row.user_id}\nСостояние: ${row.state}${row.decision ? '\nРешение: ' + row.decision : ''}\n\n` +
        form.questions
          .map(
            (question) =>
              `**${question.label}**\n${Array.isArray(answers[question.id]) ? (answers[question.id] as string[]).join(', ') : answers[question.id] || '—'}`,
          )
          .join('\n\n');
      const parts = text.match(/[\s\S]{1,2800}/g) || [],
        saved = this.configs.state<string[]>('forms', 'messages:' + row.id) || [];
      for (let index = 0; index < parts.length; index++) {
        const id = await sendBlocks(
          this.context.discord,
          this.context.store,
          form.channelId,
          [
            {
              id: 'form',
              type: 'text',
              content: (index === 0 && form.mentionRole ? `<@&${form.mentionRole}>\n` : '') + parts[index],
            },
          ],
          [],
          `form:${row.id}:${index}`,
          saved[index],
          form.mentionRole,
        );
        saved[index] = id;
        this.configs.set('forms', 'messages:' + row.id, saved);
      }
      for (const id of saved.slice(parts.length)) {
        try {
          await rest.delete(`/channels/${form.channelId}/messages/${id}`, {
            signal: AbortSignal.timeout(10000),
          });
        } catch (error) {
          if ((error as { code?: number }).code !== 10008) throw error;
        }
      }
      saved.splice(parts.length);
      this.configs.set('forms', 'messages:' + row.id, saved);
      if (form.thread && !row.thread_id) {
        const thread = (await rest.post(`/channels/${form.channelId}/messages/${saved[0]}/threads`, {
          body: { name: `Заявка ${row.id}`, auto_archive_duration: 1440 },
          signal: AbortSignal.timeout(10000),
        })) as { id: string };
        this.context.store.sqlite
          .prepare('UPDATE form_submissions SET thread_id=? WHERE id=?')
          .run(thread.id, row.id);
      }
      if (row.state === 'accepted') {
        const applied = this.configs.state<boolean>('forms', 'reward:' + row.id);
        if (!applied) {
          if (form.grantRole)
            await new GuildAuthority(this.context.config, this.context.discord, this.context.store).safeRole(
              this.context.config.clientId,
              row.user_id,
              form.grantRole,
              [form.grantRole],
              true,
            );
          this.context.store.sqlite
            .transaction(() => {
              if (this.configs.state<boolean>('forms', 'reward:' + row.id)) return;
              if (form.ticketCategory)
                new TicketService(
                  this.context.config,
                  this.context.store,
                  this.context.discord,
                  this.context.activity,
                  (error, scope) => this.context.errors.report(error, scope),
                ).reserve(row.user_id, form.ticketCategory, {});
              this.configs.set('forms', 'reward:' + row.id, true);
            })
            .immediate();
        }
      }
      this.context.store.sqlite
        .prepare("UPDATE form_submissions SET message_id=?,delivery_state='sent' WHERE id=?")
        .run(saved[0] || null, row.id);
    }
  }
}
