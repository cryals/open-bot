import { z } from 'zod';

export const snowflake = z.string().regex(/^\d{17,20}$/, 'Некорректный Discord ID');
export const ruleKey = z.enum(['discord', 'game']);
export const pageSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  title: z.string().trim().min(1).max(150),
  body: z.string().trim().min(1).max(30000),
  enabled: z.boolean(),
});
export const rulesetSchema = z.object({
  key: ruleKey,
  title: z.string().trim().min(1).max(120),
  intro: z.string().trim().min(1).max(800),
  pages: z
    .array(pageSchema)
    .min(1)
    .max(100)
    .refine((pages) => pages.some((page) => page.enabled), 'Нужна хотя бы одна включённая страница')
    .refine(
      (pages) => new Set(pages.map((page) => page.id)).size === pages.length,
      'ID страниц должны быть уникальны',
    ),
});
export const documentSchema = z.object({
  launcherTitle: z.string().trim().min(1).max(120),
  launcherBody: z.string().trim().min(1).max(1800),
  rulesets: z
    .tuple([rulesetSchema, rulesetSchema])
    .refine((sets) => sets[0].key === 'discord' && sets[1].key === 'game', 'Ожидаются наборы Discord и Игра'),
});
export const settingsSchema = z.object({
  channelId: snowflake.nullable(),
  adminRoleId: snowflake.nullable(),
});
export type RuleKey = z.infer<typeof ruleKey>;
export type RulePage = z.infer<typeof pageSchema>;
export type Ruleset = z.infer<typeof rulesetSchema>;
export type RulesDocument = z.infer<typeof documentSchema>;
export type SettingsInput = z.infer<typeof settingsSchema>;
export type ViewPage = { sourceId: string; title: string; body: string };

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

// One shared paginator drives the real Discord message and the web preview.
// Leave space for component JSON, intro, headings and navigation under 10 KB.
export function paginate(set: Ruleset): ViewPage[] {
  const views: ViewPage[] = [];
  for (const page of set.pages.filter((item) => item.enabled)) {
    const prefix = `# ${set.title}\n${set.intro}\n## ${page.title} — продолжение\n`;
    const charLimit = Math.min(3000, 3500 - prefix.length);
    const byteLimit = 6800 - bytes(prefix);
    let remaining = page.body.trim();
    let part = 0;
    while (remaining) {
      let end = 0;
      let size = 0;
      for (const character of remaining) {
        const next = bytes(character);
        if (end + character.length > charLimit || size + next > byteLimit) break;
        end += character.length;
        size += next;
      }
      if (end < remaining.length) {
        const candidate = remaining.slice(0, end);
        const boundary = Math.max(candidate.lastIndexOf('\n\n'), candidate.lastIndexOf('\n'));
        const space = candidate.lastIndexOf(' ');
        if (boundary > end / 2) end = boundary;
        else if (space > end / 2) end = space;
      }
      views.push({
        sourceId: page.id,
        title: page.title + (part ? ' — продолжение' : ''),
        body: remaining.slice(0, end).trim(),
      });
      remaining = remaining.slice(end).trim();
      part++;
    }
  }
  return views;
}

export type RevisionSummary = { id: number; actor: string; createdAt: number };
export type Workspace = {
  document: RulesDocument;
  version: number;
  updatedAt: number;
  settings: SettingsInput & {
    messageId: string | null;
    messageChannelId: string | null;
    publishedRevision: number | null;
  };
  revisions: RevisionSummary[];
};
export type SessionUser = { id: string; name: string };
export type GuildInfo = {
  id: string;
  name: string;
  ready: boolean;
  channels: { id: string; name: string }[];
  roles: { id: string; name: string }[];
};
