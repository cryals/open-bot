import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { PermissionFlagsBits } from 'discord.js';
import { botModules } from '../src/server/modules/catalog.js';
import { webModuleMetadata } from '../src/server/modules/web/metadata.js';
import type { BotModule } from '../src/server/runtime/types.js';
import { capabilityTitles } from '../src/shared/settings.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const formatting = (await resolveConfig(resolve(root, 'mkdocs.yml'))) || {};
const pageStart = '<!-- module-reference:start -->',
  pageEnd = '<!-- module-reference:end -->';
const navStart = '  # module-reference-nav:start',
  navEnd = '  # module-reference-nav:end';
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const names = new Set<string>();
type Entry = Pick<
  BotModule,
  'id' | 'title' | 'description' | 'commands' | 'dependencies' | 'requirements'
> & { process: 'Bot' | 'Web' };
const modules: Entry[] = [];
for (const source of botModules) {
  const module = (await source.load()).default;
  if (module.id !== source.id || !/^[a-z0-9][a-z0-9_-]*$/.test(module.id))
    throw new Error('Invalid module ID: ' + source.id);
  modules.push({ ...module, process: 'Bot' });
}
modules.push({ ...webModuleMetadata, process: 'Web' });
if (new Set(modules.map((module) => module.id)).size !== modules.length)
  throw new Error('Duplicate module ID');

type Option = { type: number; name: string; description: string; options?: Option[] };
function commands(module: Entry) {
  const rows: string[] = [];
  for (const command of module.commands || []) {
    const json = command.data.toJSON();
    if (names.has(json.name)) throw new Error('Duplicate slash command: ' + json.name);
    names.add(json.name);
    const access = command.admin
      ? 'Администрация'
      : command.permission === 'ticketManage'
        ? 'Управление Ticket'
        : command.permission
          ? capabilityTitles[command.permission]
          : 'Проверяется обработчиком';
    const visit = (name: string, description: string, options: Option[]) => {
      const children = options.filter((option) => option.type === 1 || option.type === 2);
      if (children.length)
        for (const child of children) visit(name + ' ' + child.name, child.description, child.options || []);
      else rows.push(`| \`/${name}\` | ${cell(description)} | ${access} |`);
    };
    visit(json.name, json.description, (json.options || []) as Option[]);
  }
  return rows;
}

/** Only marked regions are owned by generation. Handwritten notes outside them stay intact. */
async function writeManaged(relative: string, body: string) {
  const path = resolve(root, relative),
    generated =
      pageStart +
      '\n\n' +
      (await format(body, { ...formatting, parser: 'markdown' })).trimEnd() +
      '\n\n' +
      pageEnd;
  if (!existsSync(path)) {
    writeFileSync(path, generated + '\n');
    return;
  }
  const old = readFileSync(path, 'utf8'),
    start = old.indexOf(pageStart),
    end = old.indexOf(pageEnd);
  if (start < 0 && end < 0) {
    writeFileSync(path, (old.trimEnd() ? old.trimEnd() + '\n\n' : '') + generated + '\n');
    return;
  }
  if (
    start < 0 ||
    end < start ||
    old.indexOf(pageStart, start + 1) >= 0 ||
    old.indexOf(pageEnd, end + 1) >= 0
  )
    throw new Error('Invalid generated markers: ' + relative);
  writeFileSync(path, old.slice(0, start) + generated + old.slice(end + pageEnd.length));
}
mkdirSync(resolve(root, 'docs/user/modules'), { recursive: true });
const overview = [
  '# Все модули Open Bot',
  '',
  'Сводка автоматически собирается из метаданных модулей и slash-definitions. Выберите модуль в таблице или в меню вики.',
  '',
  '| Модуль | Назначение | Процесс | Команд |',
  '| --- | --- | --- | --- |',
];
const nav = [navStart, '  - Модули:', '      - Все модули: user/catalog.md'];
for (const module of modules) {
  const rows = commands(module),
    lines = [
      '# ' + module.title,
      '',
      module.description,
      '',
      `**ID:** \`${module.id}\` · **Процесс:** ${module.process}.`,
      '',
    ];
  if (module.dependencies?.length)
    lines.push('**Зависимости:** ' + module.dependencies.map((id) => '`' + id + '`').join(', ') + '.', '');
  if (module.requirements?.intents?.length)
    lines.push(
      '**События Gateway:** ' +
        module.requirements.intents.map((intent) => '`' + intent + '`').join(', ') +
        '.',
      '',
    );
  if (module.requirements?.permissions?.length)
    lines.push(
      '**Права бота:** ' +
        module.requirements.permissions
          .map(
            (permission) =>
              Object.entries(PermissionFlagsBits).find(([, value]) => value === permission)?.[0] ||
              String(permission),
          )
          .map((value) => '`' + value + '`')
          .join(', ') +
        '.',
      '',
    );
  lines.push('## Команды', '');
  if (rows.length)
    lines.push(
      '| Команда | Назначение | Доступ |',
      '| --- | --- | --- |',
      ...rows,
      '',
      'Доступ проверяется по актуальным ролям и правам Discord. У отдельных подкоманд могут быть дополнительные ограничения; справочник не выдаёт полномочий.',
    );
  else
    lines.push(
      module.process === 'Web'
        ? 'Slash-команд нет. Модуль обслуживает веб-панель в отдельном процессе.'
        : 'Собственных slash-команд нет. Модуль обрабатывает события или фоновые операции.',
    );
  if (module.id === 'custom-commands')
    lines.push(
      '',
      'Пользовательские slash-команды зависят от сохранённой конфигурации и появляются после регистрации через панель. В статический каталог они не включены.',
    );
  lines.push('', '[Все модули](../catalog.md) · [Настройка модулей](../community.md)');
  await writeManaged('docs/user/modules/' + module.id + '.md', lines.join('\n'));
  overview.push(
    `| [${cell(module.title)}](modules/${module.id}.md) | ${cell(module.description)} | ${module.process} | ${rows.length} |`,
  );
  nav.push(`      - ${JSON.stringify(module.title)}: user/modules/${module.id}.md`);
}
// This legacy catalog is entirely generated, unlike individual pages with handwritten notes.
const catalog = resolve(root, 'docs/user/catalog.md');
if (existsSync(catalog) && !readFileSync(catalog, 'utf8').includes(pageStart)) writeFileSync(catalog, '');
await writeManaged('docs/user/catalog.md', overview.join('\n'));
nav.push(navEnd);
const configPath = resolve(root, 'mkdocs.yml'),
  config = readFileSync(configPath, 'utf8'),
  start = config.indexOf(navStart),
  end = config.indexOf(navEnd);
if (start < 0 || end < start) throw new Error('Module navigation markers are missing in mkdocs.yml');
const formattedNav = (await format('nav:\n' + nav.join('\n') + '\n', { ...formatting, parser: 'yaml' }))
  .replace(/^nav:\r?\n/, '')
  .trimEnd();
writeFileSync(configPath, config.slice(0, start) + formattedNav + config.slice(end + navEnd.length));
console.info(
  `Documented ${modules.length} modules (${botModules.length} Bot + Web), ${names.size} static slash commands.`,
);
