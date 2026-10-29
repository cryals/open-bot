import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { Background } from './Background.js';
import './style.css';
import './builder.css';
import './theme.css';

createRoot(document.getElementById('root')!).render(
  <>
    <Background />
    <App />
  </>,
);
