import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, ArrowRight, House, Eye } from 'lucide-react';
import { paginate, type Ruleset } from '../shared/rules.js';

export function RuleMarkdown({ children }: { children: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ children, href }) => (
          <a href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ),
        img: ({ alt }) => <span>[{alt || 'Изображение'}]</span>,
      }}
    >
      {children}
    </Markdown>
  );
}
export function Preview({
  set,
  index,
  onIndex,
}: {
  set: Ruleset;
  index: number;
  onIndex: (index: number) => void;
}) {
  const pages = paginate(set);
  const position = Math.min(index, pages.length - 1);
  const page = pages[position];
  return (
    <aside className="preview-panel" aria-label="Предпросмотр правил">
      <div className="preview-heading">
        <Eye size={16} />
        <span>Так увидят игроки</span>
        <span className="preview-format">Discord</span>
      </div>
      <div className="discord-surface">
        <div className="discord-author">
          <span className="bot-avatar">OS</span>
          <strong>Open Space</strong>
          <span className="app-tag">APP</span>
        </div>
        <div className="discord-card">
          <div className="markdown">
            <RuleMarkdown>{'# ' + set.title + '\n\n' + set.intro}</RuleMarkdown>
          </div>
          <hr />
          {page ? (
            <div className="markdown">
              <RuleMarkdown>{'## ' + page.title + '\n\n' + page.body}</RuleMarkdown>
            </div>
          ) : (
            <p>Включите хотя бы одну страницу.</p>
          )}
          <hr />
          <div className="discord-controls">
            <button
              aria-label="Предыдущая страница предпросмотра"
              disabled={position <= 0}
              onClick={() => onIndex(position - 1)}
            >
              <ArrowLeft size={14} />
              Назад
            </button>
            <span>
              {page ? position + 1 : 0}/{pages.length}
            </span>
            <button
              aria-label="Следующая страница предпросмотра"
              disabled={position >= pages.length - 1}
              onClick={() => onIndex(position + 1)}
            >
              Вперёд
              <ArrowRight size={14} />
            </button>
            <button aria-label="В начало предпросмотра" onClick={() => onIndex(0)}>
              <House size={14} />
            </button>
          </div>
        </div>
        <p className="ephemeral-note">
          <Eye size={12} /> Только вы видите это сообщение
        </p>
      </div>
      <p className="preview-note">
        Вступление остаётся на каждой странице. Длинные разделы автоматически делятся на продолжения.
      </p>
    </aside>
  );
}
