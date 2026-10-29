import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { documentSchema, type RulePage, type RulesDocument } from '../shared/rules.js';

function sections(source: string, marker: string): RulePage[] {
  const chunks = source.split(new RegExp('^' + marker + ' ', 'm')).slice(1);
  return chunks.map((part, index) => {
    const newline = part.indexOf('\n');
    return {
      id: 'section-' + index,
      title: part.slice(0, newline).trim(),
      body: part.slice(newline).trim(),
      enabled: true,
    };
  });
}

export function loadSeed(): RulesDocument {
  const game = readFileSync(resolve('rules/game.md'), 'utf8').replace(/\r/g, '');
  const discord = readFileSync(resolve('rules/discord.md'), 'utf8').replace(/\r/g, '');
  const gamePages = sections(game, '##');
  const discordPages = sections(discord, '##')
    .filter((page) => page.title.startsWith('Страница'))
    .map((page) => ({ ...page, title: page.title.replace(/^Страница \d+ — /, '') }));
  return documentSchema.parse({
    launcherTitle: 'Правила Open Space',
    launcherBody:
      '**Правила Discord** — общение и поведение в сообществе.\n\n**Правила игры** — ролевая игра и взаимодействие на сервере Open Space 16+.\n\nВыберите раздел. Страницы с правилами будут видны только вам.',
    rulesets: [
      {
        key: 'discord',
        title: 'Правила Discord',
        intro:
          'Правила основаны на [Условиях Discord](https://discord.com/terms) и [Правилах сообщества](https://discord.com/guidelines). За нарушения возможны мут, кик или бан по решению модерации.',
        pages: discordPages,
      },
      {
        key: 'game',
        title: 'Правила Open Space',
        intro: game
          .split(/^## /m)[0]
          .replace(/^# .*\n+/, '')
          .trim(),
        pages: gamePages,
      },
    ],
  });
}
