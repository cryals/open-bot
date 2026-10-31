import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { Background } from './Background.js';
import './style.css';
import './builder.css';
import './theme.css';
import { PublicForm } from './PublicForm.js';
const formMatch = location.pathname.match(/^\/forms\/([a-z0-9][a-z0-9_-]{0,39})$/);

createRoot(document.getElementById('root')!).render(
  <>
    <Background />
    {formMatch ? <PublicForm id={formMatch[1]} /> : <App />}
  </>,
);
