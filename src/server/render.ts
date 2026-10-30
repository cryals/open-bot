import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { paginate, type RulesDocument, type RuleKey } from '../shared/rules.js';
import { renderBlock } from './blocks.js';
import { customMessage } from './blocks.js';
import { infoBlocks } from '../shared/rules.js';
import { HttpError } from './errors.js';

const button = (label: string, id: string, disabled = false) =>
  new ButtonBuilder().setLabel(label).setCustomId(id).setStyle(ButtonStyle.Secondary).setDisabled(disabled);
const text = (content: string) => new TextDisplayBuilder().setContent(content);
const separator = () => new SeparatorBuilder().setDivider(true);
const container = () => new ContainerBuilder().setAccentColor(0x508b9d);
export function notice(message: string) {
  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components: [container().addTextDisplayComponents(text(message))],
    allowedMentions: { parse: [] as never[] },
  };
}

export function launcher(document: RulesDocument) {
  if (document.launcherBlocks)
    return customMessage({
      id: 'launcher',
      blocks: infoBlocks(document),
      silent: false,
      mentions: { users: false, roles: false, everyone: false },
    });
  const card = container()
    .addTextDisplayComponents(text('# ' + document.launcherTitle), text(document.launcherBody))
    .addSeparatorComponents(separator())
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button('Читать правила', 'os:v1:open').setStyle(ButtonStyle.Primary),
      ),
    );
  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components: [card],
    allowedMentions: { parse: [] as never[] },
  };
}
export function menu(document: RulesDocument, userId: string) {
  const card = container().addTextDisplayComponents(
    text('# Правила сообщества'),
    text('Выберите правила, которые хотите прочитать.'),
  );
  card.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...document.rulesets.map((set) =>
        button(set.key === 'game' ? 'Игра' : 'Discord', `os:v1:page:${userId}:${set.key}:0`).setStyle(
          ButtonStyle.Primary,
        ),
      ),
    ),
  );
  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components: [card],
    allowedMentions: { parse: [] as never[] },
  };
}
export function rulesView(document: RulesDocument, key: RuleKey, index: number, userId: string) {
  const set = document.rulesets.find((set) => set.key === key)!;
  const pages = paginate(set);
  const pageIndex = Math.min(Math.max(index, 0), pages.length - 1);
  const page = pages[pageIndex];
  const header = container().addTextDisplayComponents(text('# ' + set.title), text(set.intro));
  const navigation = new ActionRowBuilder<ButtonBuilder>().addComponents(
    button('← Назад', `os:v1:page:${userId}:${key}:${Math.max(0, pageIndex - 1)}`, pageIndex === 0),
    button(`${pageIndex + 1} / ${pages.length}`, `os:v1:count:${userId}`, true),
    button('Вперёд →', `os:v1:page:${userId}:${key}:${pageIndex + 1}`, pageIndex === pages.length - 1),
    button('Меню', `os:v1:menu:${userId}`),
  );
  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components: [
      header.toJSON(),
      { type: 10 as const, content: '## ' + page.title },
      ...page.blocks.map(renderBlock),
      navigation.toJSON(),
    ],
    allowedMentions: { parse: [] as never[] },
  };
}
export function validatePayloads(document: RulesDocument) {
  const payloads: { components: unknown[] }[] = [launcher(document), menu(document, '111111111111111111')];
  for (const set of document.rulesets) {
    for (let index = 0; index < paginate(set).length; index++)
      payloads.push(rulesView(document, set.key, index, '111111111111111111'));
  }
  for (const payload of payloads) {
    if (Buffer.byteLength(JSON.stringify(payload)) > 10000)
      throw new HttpError(
        400,
        'Страница превышает безопасный размер сообщения Discord. Сократите заголовок или вступление.',
      );
    const json = JSON.parse(JSON.stringify(payload)) as { components: unknown[] };
    function count(value: unknown): number {
      if (!value || typeof value !== 'object') return 0;
      const item = value as { type?: number; components?: unknown[]; accessory?: unknown };
      return (
        (item.type ? 1 : 0) +
        (item.components?.reduce<number>((sum, child) => sum + count(child), 0) || 0) +
        count(item.accessory)
      );
    }
    if (json.components.reduce<number>((sum, component) => sum + count(component), 0) > 40)
      throw new HttpError(400, 'Превышен лимит 40 компонентов Discord');
  }
}
