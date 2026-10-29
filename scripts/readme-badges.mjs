import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// These badges describe the project. Build results remain on the Actions page.
const badges = [
  ['status', 'STATUS', 'IN DEVELOPMENT'],
  ['runtime', 'NODE', '24.18+'],
  ['discord', 'DISCORD', 'COMPONENTS V2'],
  ['hosting', 'DEPLOY', 'SELF-HOSTED'],
  ['license', 'LICENSE', 'CUSTOM'],
  ['checks', 'CI', 'VIEW RUNS'],
];
const directory = new URL('../docs/assets/badges/', import.meta.url);
mkdirSync(directory, { recursive: true });

for (const [name, label, value] of badges) {
  const divider = 20 + label.length * 7;
  const width = divider + 22 + value.length * 7;
  const title = `${label}: ${value}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="28" viewBox="0 0 ${width} 28" role="img" aria-label="${title}">
  <title>${title}</title>
  <rect x=".5" y=".5" width="${width - 1}" height="27" fill="#080808" stroke="#444442"/>
  <path d="M${divider} 1v26" stroke="#444442"/>
  <path d="M.5 7V.5H7 M${width - 7} 27.5h6.5V21" fill="none" stroke="#f4f4f2"/>
  <g font-family="'DejaVu Sans Mono',monospace" font-size="11" letter-spacing=".2">
    <text x="10" y="18" fill="#969694">${label}</text>
    <text x="${divider + 11}" y="18" fill="#f4f4f2">${value}</text>
  </g>
</svg>
`;
  writeFileSync(new URL(`${name}.svg`, directory), svg);
}
console.log(`Wrote ${badges.length} README badges to ${fileURLToPath(directory)}`);
