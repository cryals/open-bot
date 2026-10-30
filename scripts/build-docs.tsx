import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Explicit page manifest: private specs, reports and local files are not published.
const pages = [
  ['README.md', 'Документация', 'home'],
  ['RELEASE-1.0.md', 'Релиз 1.0', 'home'],
  ['user/README.md', 'Пользователю', 'user'],
  ['user/setup.md', 'Установка и первый вход', 'user'],
  ['user/rules.md', 'Правила и информация', 'user'],
  ['user/messages.md', 'Сообщения бота', 'user'],
  ['user/logs.md', 'Журнал и восстановление', 'user'],
  ['user/commands.md', 'Команды', 'user'],
  ['user/troubleshooting.md', 'Решение проблем', 'user'],
  ['developer/README.md', 'Разработчику', 'developer'],
  ['developer/architecture.md', 'Архитектура', 'developer'],
  ['developer/modules.md', 'Создание модулей', 'developer'],
  ['developer/telemetry.md', 'Журнал, ошибки и метрики', 'developer'],
  ['developer/workflow.md', 'Разработка и выпуск', 'developer'],
  ['developer/skills.md', 'Навыки Codex', 'developer'],
  ['OPERATIONS.md', 'Справочник эксплуатации', 'user'],
  ['DOCKER.md', 'Docker Compose', 'user'],
  ['MODULES.md', 'Runtime и команды', 'developer'],
  ['PERFORMANCE.md', 'Производительность', 'developer'],
] as const;
const htmlPath = (path: string) => path.replace(/README\.md$/, 'index.html').replace(/\.md$/, '.html');
const sourceRoot = resolve('docs');
const outputRoot = resolve('dist/web/docs');
// This is a generated subtree, never the source docs directory.
if (relative(resolve('.'), outputRoot) !== ['dist', 'web', 'docs'].join(sep))
  throw new Error('Unexpected documentation output path');
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await cp(resolve(sourceRoot, 'portal.css'), resolve(outputRoot, 'portal.css'));
await cp(resolve(sourceRoot, 'assets/screenshots'), resolve(outputRoot, 'assets/screenshots'), {
  recursive: true,
});
const repository = 'https://github.com/cryals/open-bot/blob/main/';
type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, string> };
};
function headingAnchors() {
  return (tree: MarkdownNode) => {
    const used = new Map<string, number>();
    const text = (node: MarkdownNode): string => node.value || node.children?.map(text).join('') || '';
    const visit = (node: MarkdownNode) => {
      if (node.type === 'heading') {
        const slug = text(node)
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s_-]/gu, '')
          .replace(/\s/g, '-');
        const count = used.get(slug) || 0;
        used.set(slug, count + 1);
        node.data = {
          ...node.data,
          hProperties: { ...node.data?.hProperties, id: slug + (count ? '-' + count : '') },
        };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

for (const [source, title, group] of pages) {
  const output = htmlPath(source);
  const prefix = relative(dirname(output), '.').split(sep).join('/') || '.';
  const link = (href = '') => {
    if (/^(?:https?:|mailto:|#)/i.test(href)) return href;
    const [path, fragment] = href.split('#');
    const target = resolve(sourceRoot, dirname(source), path);
    const normalized = relative(sourceRoot, target).split(sep).join('/');
    const suffix = fragment ? '#' + fragment : '';
    if (pages.some(([page]) => page === normalized)) return `${prefix}/${htmlPath(normalized)}${suffix}`;
    if (!normalized.startsWith('assets/screenshots/'))
      return repository + relative(resolve('.'), target).split(sep).join('/') + suffix;
    return href;
  };
  const markdown = await readFile(resolve(sourceRoot, source), 'utf8');
  const html = renderToStaticMarkup(
    <html lang="ru">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${title} · Open Bot`}</title>
        <meta
          name="description"
          content={`Open Bot 1.0 — ${title}. Руководство по выпущенным возможностям.`}
        />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href={`${prefix}/portal.css`} />
      </head>
      <body>
        <a className="skip" href="#content">
          К содержанию
        </a>
        <header>
          <a className="brand" href={`${prefix}/index.html`}>
            OPEN BOT <small>ДОКУМЕНТАЦИЯ</small>
          </a>
          <nav aria-label="Порталы">
            <a aria-current={group === 'user' ? 'page' : undefined} href={`${prefix}/user/index.html`}>
              Пользователю
            </a>
            <a
              aria-current={group === 'developer' ? 'page' : undefined}
              href={`${prefix}/developer/index.html`}
            >
              Разработчику
            </a>
            <a href="/">Панель ↗</a>
          </nav>
        </header>
        <div className="layout">
          <aside>
            <p>РУКОВОДСТВА</p>
            <nav aria-label="Страницы документации">
              {pages
                .filter((page) => page[2] === group || page[2] === 'home')
                .map(([path, label]) => (
                  <a
                    key={path}
                    href={`${prefix}/${htmlPath(path)}`}
                    aria-current={source === path ? 'page' : undefined}
                  >
                    {label}
                  </a>
                ))}
            </nav>
            <p className="version">РЕЛИЗ 1.0</p>
          </aside>
          <main id="content" tabIndex={-1}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm, headingAnchors]}
              components={{
                a: ({ href, children }) => <a href={link(href)}>{children}</a>,
                img: ({ src, alt }) => <img src={src} alt={alt || ''} loading="lazy" />,
              }}
            >
              {markdown}
            </ReactMarkdown>
            <footer>
              <a href={repository + 'docs/' + source}>Править исходник на GitHub</a>
              <span>Open Bot · 1.0</span>
            </footer>
          </main>
        </div>
      </body>
    </html>,
  );
  await mkdir(dirname(resolve(outputRoot, output)), { recursive: true });
  await writeFile(resolve(outputRoot, output), '<!doctype html>\n' + html);
}
console.info(`Built ${pages.length} documentation pages in dist/web/docs`);
