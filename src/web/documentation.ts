/** The wiki is deployed independently; GitHub Markdown works before a wiki host is configured. */
export function documentation(path = '') {
  const configured = import.meta.env.VITE_DOCS_URL as string | undefined;
  if (!configured)
    return 'https://github.com/cryals/open-bot/blob/main/docs/' + (path ? path + '.md' : 'README.md');
  const base = new URL(configured.endsWith('/') ? configured : configured + '/');
  if (!['https:', 'http:'].includes(base.protocol)) throw new Error('VITE_DOCS_URL must be HTTP(S)');
  return new URL(path ? path + '/' : '', base).href;
}
