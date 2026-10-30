import { memo, useEffect, useState } from 'react';
import { File, ImageOff } from 'lucide-react';
import type { Block } from '../shared/blocks.js';
import { RuleMarkdown } from './Markdown.js';

function PicturePreview({
  url,
  description,
  spoiler,
}: {
  url: string;
  description: string;
  spoiler: boolean;
}) {
  const [error, setError] = useState(false);
  useEffect(() => setError(false), [url]);
  const image =
    !url || error ? (
      <div className="image-placeholder">
        <ImageOff size={22} />
        <span>{url ? 'Изображение недоступно' : 'Добавьте изображение'}</span>
      </div>
    ) : (
      <img
        src={url}
        loading="lazy"
        decoding="async"
        alt={description || 'Изображение'}
        referrerPolicy="no-referrer"
        onError={() => setError(true)}
      />
    );
  return spoiler ? (
    <details className="spoiler-preview">
      <summary>Показать изображение · Спойлер</summary>
      {image}
    </details>
  ) : (
    image
  );
}
export const BlocksPreview = memo(function BlocksPreview({ blocks }: { blocks: Block[] }) {
  return (
    <div className="blocks-preview">
      {blocks.map((block, index) => (
        <div className={'preview-block preview-' + block.type} key={block.id + ':' + index}>
          {block.type === 'text' && (
            <div className="markdown">
              <RuleMarkdown>{block.content || '*Текст…*'}</RuleMarkdown>
            </div>
          )}
          {block.type === 'separator' && (
            <div className={'component-separator ' + block.spacing + (block.divider ? ' has-line' : '')} />
          )}
          {block.type === 'gallery' && (
            <div className={'media-grid media-count-' + block.items.length}>
              {block.items.length ? (
                block.items.map((item, i) => (
                  <figure key={i}>
                    <PicturePreview {...item} />
                    {item.description && <figcaption>{item.description}</figcaption>}
                  </figure>
                ))
              ) : (
                <div className="image-placeholder">
                  <ImageOff size={25} />
                  Добавьте изображения в галерею
                </div>
              )}
            </div>
          )}
          {block.type === 'section' && (
            <div className="component-section">
              <div>
                {block.texts.map((text, i) => (
                  <div className="markdown" key={i}>
                    <RuleMarkdown>{text}</RuleMarkdown>
                  </div>
                ))}
              </div>
              <div className="section-accessory">
                {block.accessory.type === 'thumbnail' ? (
                  <PicturePreview {...block.accessory} />
                ) : (
                  <a
                    className="preview-link-button"
                    href={block.accessory.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {block.accessory.label || 'Кнопка'} ↗
                  </a>
                )}
              </div>
            </div>
          )}
          {block.type === 'actions' && (
            <div className="component-buttons">
              {block.buttons.length ? (
                block.buttons.map((button) =>
                  'action' in button ? (
                    <button
                      className="preview-link-button builtin-button"
                      key={button.id}
                      type="button"
                      title="Открывает личное меню правил в Discord"
                    >
                      {button.label}
                    </button>
                  ) : (
                    <a
                      className="preview-link-button"
                      key={button.id}
                      href={button.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {button.label || 'Кнопка'} ↗
                    </a>
                  ),
                )
              ) : (
                <small>Добавьте кнопки-ссылки</small>
              )}
            </div>
          )}
          {block.type === 'file' && (
            <a className="preview-file" href={block.url || undefined} target="_blank" rel="noreferrer">
              <File size={24} />
              {block.spoiler ? 'Спойлер · ' : ''}
              {block.name || 'Выберите файл'}
            </a>
          )}
          {block.type === 'container' && (
            <div className="preview-container" style={{ borderLeftColor: block.color }}>
              {block.spoiler ? (
                <details className="spoiler-preview">
                  <summary>Показать контейнер · Спойлер</summary>
                  <BlocksPreview blocks={block.children} />
                </details>
              ) : block.children.length ? (
                <BlocksPreview blocks={block.children} />
              ) : (
                <small>Пустой контейнер</small>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
});
