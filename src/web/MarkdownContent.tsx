import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function MarkdownContent({ children }: { children: string }) {
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
