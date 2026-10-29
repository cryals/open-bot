import { lazy, Suspense } from 'react';
const MarkdownContent = lazy(() => import('./MarkdownContent.js'));
export function RuleMarkdown({ children }: { children: string }) {
  return (
    <Suspense fallback={<p>{children}</p>}>
      <MarkdownContent>{children}</MarkdownContent>
    </Suspense>
  );
}
