import { z } from 'zod';
import {
  blockSchema,
  blockText,
  componentCount,
  mediaRefs,
  uniqueBlockIds,
  type Block,
  type ChildBlock,
} from './blocks.js';

export const snowflake = z.string().regex(/^\d{17,20}$/, 'Некорректный Discord ID');
export const ruleKey = z.enum(['discord', 'game']);
export const pageSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    title: z.string().trim().min(1).max(150),
    body: z.string().trim().max(30000).default(''),
    blocks: z
      .array(blockSchema)
      .min(1)
      .max(100)
      .refine(uniqueBlockIds, 'ID блоков должны быть уникальны')
      .optional(),
    enabled: z.boolean(),
  })
  .refine((page) => Boolean(page.blocks?.length || page.body), 'Добавьте текст или блоки страницы');
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
  launcherBlocks: z
    .array(blockSchema)
    .min(1)
    .max(40)
    .refine(uniqueBlockIds, 'ID блоков должны быть уникальны')
    .optional(),
  rulesets: z
    .tuple([rulesetSchema, rulesetSchema])
    .refine((sets) => sets[0].key === 'discord' && sets[1].key === 'game', 'Ожидаются наборы Discord и Игра'),
});
export const settingsSchema = z.object({
  channelId: snowflake.nullable(),
  adminRoleId: snowflake.nullable(),
  logChannelId: snowflake.nullable().optional(),
});
export type RuleKey = z.infer<typeof ruleKey>;
export type RulePage = z.infer<typeof pageSchema>;
export type Ruleset = z.infer<typeof rulesetSchema>;
export type RulesDocument = z.infer<typeof documentSchema>;
export function infoBlocks(document: RulesDocument): Block[] {
  return (
    document.launcherBlocks ?? [
      {
        id: 'info-container',
        type: 'container',
        color: '#5865f2',
        spoiler: false,
        children: [
          { id: 'info-title', type: 'text', content: '# ' + document.launcherTitle },
          { id: 'info-description', type: 'text', content: document.launcherBody },
          {
            id: 'info-rules-row',
            type: 'actions',
            buttons: [{ id: 'info-read-rules', label: 'Читать правила', action: 'rules' }],
          },
        ],
      },
    ]
  );
}
export type SettingsInput = z.infer<typeof settingsSchema>;
export type ViewPage = { sourceId: string; title: string; body: string; blocks: Block[] };

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

// One shared paginator drives the real Discord message and the web preview.
// Leave space for component JSON, intro, headings and navigation under 10 KB.
export function pageBlocks(page: RulePage): Block[] {
  return (
    page.blocks ??
    page.body
      .split(/(?=^### |^- )/m)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((content, index) => ({ id: 'legacy-' + index, type: 'text', content }))
  );
}

function splitText(content: string, chars: number, byteLimit: number): string[] {
  const chunks: string[] = [];
  let remaining = content.trim();
  while (remaining) {
    let end = 0;
    let size = 0;
    for (const char of remaining) {
      const next = bytes(char);
      if (end + char.length > chars || size + next > byteLimit) break;
      end += char.length;
      size += next;
    }
    if (end < remaining.length) {
      const candidate = remaining.slice(0, end);
      const boundary = Math.max(
        candidate.lastIndexOf('\n\n'),
        candidate.lastIndexOf('\n'),
        candidate.lastIndexOf(' '),
      );
      if (boundary > end / 2) end = boundary;
    }
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  return chunks.length ? chunks : [''];
}

export function paginate(set: Ruleset): ViewPage[] {
  const views: ViewPage[] = [];
  for (const page of set.pages.filter((item) => item.enabled)) {
    const prefix = `# ${set.title}\n${set.intro}\n## ${page.title} — продолжение\n`;
    const charLimit = Math.min(3000, 3500 - prefix.length);
    const byteLimit = 7300 - bytes(prefix);
    const fits = (blocks: Block[]) =>
      componentCount(blocks) <= 30 &&
      blocks.map(blockText).join('\n\n').length <= charLimit &&
      bytes(JSON.stringify(blocks)) <= byteLimit &&
      mediaRefs(blocks).length <= 10;
    function atoms(block: Block): Block[] {
      if (fits([block])) return [block];
      if (block.type === 'text')
        return splitText(block.content, charLimit - 100, byteLimit - 500).map((content) => ({
          ...block,
          content,
        }));
      if (block.type === 'container')
        return block.children.flatMap(atoms).map((child) => ({ ...block, children: [child as ChildBlock] }));
      if (block.type === 'gallery') return block.items.map((item) => ({ ...block, items: [item] }));
      if (block.type === 'section')
        return block.texts
          .flatMap((text) => splitText(text, Math.min(1000, charLimit - 200), byteLimit - 2000))
          .map((text) => ({ ...block, texts: [text] }));
      return [block];
    }
    let group: Block[] = [];
    let part = 0;
    const flush = () => {
      if (!group.length) return;
      views.push({
        sourceId: page.id,
        title: page.title + (part ? ' — продолжение' : ''),
        body: group.map(blockText).filter(Boolean).join('\n\n'),
        blocks: group,
      });
      group = [];
      part++;
    };
    for (const block of pageBlocks(page).flatMap(atoms)) {
      if (group.length && !fits([...group, block])) flush();
      group.push(block);
    }
    flush();
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
  iconUrl: string | null;
  ready: boolean;
  channels: { id: string; name: string }[];
  roles: { id: string; name: string }[];
};
