import type { APIMessageTopLevelComponent, APIContainerComponent } from 'discord.js';
import type { Block, BotMessage } from '../shared/blocks.js';
import { messageProblem } from '../shared/blocks.js';
import { HttpError } from './errors.js';

export function renderBlock(block: Block): APIMessageTopLevelComponent {
  switch (block.type) {
    case 'text':
      return { type: 10, content: block.content };
    case 'separator':
      return { type: 14, divider: block.divider, spacing: block.spacing === 'large' ? 2 : 1 };
    case 'gallery':
      return {
        type: 12,
        items: block.items.map((item) => ({
          media: { url: item.url },
          description: item.description,
          spoiler: item.spoiler,
        })),
      };
    case 'section':
      return {
        type: 9,
        components: block.texts.map((content) => ({ type: 10 as const, content })),
        accessory:
          block.accessory.type === 'thumbnail'
            ? {
                type: 11,
                media: { url: block.accessory.url },
                description: block.accessory.description,
                spoiler: block.accessory.spoiler,
              }
            : { type: 2, style: 5, label: block.accessory.label, url: block.accessory.url },
      };
    case 'actions':
      return {
        type: 1,
        components: block.buttons.map((button, index) =>
          'action' in button
            ? {
                type: 2 as const,
                style: 1 as const,
                label: button.label,
                custom_id: 'os:v1:open:' + block.id.slice(0, 60) + ':' + index,
              }
            : {
                type: 2,
                style: 5,
                label: button.label,
                url: button.url,
              },
        ),
      };
    case 'file':
      return { type: 13, file: { url: block.url }, spoiler: block.spoiler };
    case 'container':
      return {
        type: 17,
        accent_color: parseInt(block.color.slice(1), 16),
        spoiler: block.spoiler,
        components: block.children.map(renderBlock) as APIContainerComponent['components'],
      };
  }
}
export function customMessage(message: BotMessage) {
  const problem = messageProblem(message);
  if (problem) throw new HttpError(400, problem);
  return {
    flags: (32768 | (message.silent ? 4096 : 0)) as 32768,
    components: message.blocks.map(renderBlock),
    allowedMentions: {
      parse: [
        ...(message.mentions.users ? ['users' as const] : []),
        ...(message.mentions.roles ? ['roles' as const] : []),
        ...(message.mentions.everyone ? ['everyone' as const] : []),
      ],
    },
  };
}
