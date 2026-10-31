import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
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
  const content = z
    .object({
      launcherTitle: z.string(),
      launcherBody: z.string(),
      discordTitle: z.string(),
      discordIntro: z.string(),
      gameTitle: z.string(),
    })
    .parse(JSON.parse(readFileSync(resolve('rules/content.json'), 'utf8')));
  const game = readFileSync(resolve('rules/game.md'), 'utf8').replace(/\r/g, '');
  const discord = readFileSync(resolve('rules/discord.md'), 'utf8').replace(/\r/g, '');
  const gamePages = sections(game, '##');
  const discordPages = sections(discord, '##')
    .filter((page) => page.title.startsWith('Страница'))
    .map((page) => ({ ...page, title: page.title.replace(/^Страница \d+ — /, '') }));
  return documentSchema.parse({
    launcherTitle: content.launcherTitle,
    launcherBody: content.launcherBody,
    rulesets: [
      {
        key: 'discord',
        title: content.discordTitle,
        intro: content.discordIntro,
        pages: discordPages,
      },
      {
        key: 'game',
        title: content.gameTitle,
        intro: game
          .split(/^## /m)[0]
          .replace(/^# .*\n+/, '')
          .trim(),
        pages: gamePages,
      },
    ],
  });
}
