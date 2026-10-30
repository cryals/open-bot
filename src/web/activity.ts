import { useEffect, useState } from 'react';
import { api } from './api.js';
import type { UiEvent } from '../shared/activity.js';

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const field = (target: EventTarget | null): target is Field =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement;
const excluded = (target: Field) =>
  Boolean(target.closest('[data-no-audit]')) ||
  (target instanceof HTMLInputElement && ['password', 'file', 'hidden'].includes(target.type)) ||
  /token|secret|password|csrf|cookie|authorization/i.test(target.name + ' ' + target.id);
const context = () =>
  [
    document.querySelector('main h1')?.textContent?.trim(),
    document.querySelector('.breadcrumb strong')?.textContent?.trim(),
    document.querySelector('.page-row.selected .page-select')?.textContent?.trim(),
  ]
    .filter(Boolean)
    .join(' / ')
    .slice(0, 300) || 'Панель';
const title = (target: Element) =>
  (
    target.getAttribute('aria-label') ||
    target.getAttribute('title') ||
    (field(target) ? target.labels?.[0]?.childNodes[0]?.textContent : target.textContent) ||
    target.tagName
  )
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 160);
const identity = (target: Element) =>
  [
    target.tagName.toLowerCase(),
    target.closest('[data-block-id]')?.getAttribute('data-block-id'),
    title(target),
  ]
    .filter(Boolean)
    .join(':')
    .slice(0, 300);
const value = (target: Field) =>
  target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type)
    ? String(target.checked)
    : target.value;

/** Browser observations are separate from authoritative server events. No credentials are collected. */
export function useActivity(enabled: boolean, endpoint = '/activity') {
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    const queue: UiEvent[] = [];
    const baselines = new Map<Field, { value: string; context: string; identity: string; title: string }>();
    const timers = new Map<Field, ReturnType<typeof setTimeout>>();
    let sending = false;
    let closed = false;
    function add(event: UiEvent) {
      queue.push({ ...event, occurredAt: Date.now() });
    }
    function track(target: Field) {
      if (!excluded(target) && !baselines.has(target))
        baselines.set(target, {
          value: value(target),
          context: context(),
          identity: identity(target),
          title: title(target),
        });
    }
    function change(target: Field) {
      const before = baselines.get(target);
      clearTimeout(timers.get(target));
      timers.delete(target);
      if (!before) return;
      const after = value(target);
      if (before.value !== after) {
        add({
          kind: 'ui.change',
          target: before.identity,
          summary: 'Изменено поле: ' + before.title,
          context: before.context,
          before: before.value.slice(0, 60000),
          after: after.slice(0, 60000),
        });
        before.value = after;
      }
      if (!target.isConnected) baselines.delete(target);
    }
    async function flush() {
      if (sending || !queue.length) return;
      const events = queue.slice(0, 5);
      sending = true;
      try {
        await api(endpoint, 'POST', { events });
        queue.splice(0, events.length);
        if (!closed) setError('');
      } catch {
        if (!closed) setError(`Журнал временно недоступен. Ожидают отправки: ${queue.length}.`);
      } finally {
        sending = false;
      }
    }
    const focus = (event: Event) => {
      if (field(event.target)) track(event.target);
    };
    const input = (event: Event) => {
      if (!field(event.target) || excluded(event.target)) return;
      const target = event.target;
      clearTimeout(timers.get(target));
      timers.set(
        target,
        setTimeout(() => change(target), 900),
      );
    };
    const blur = (event: Event) => {
      if (field(event.target)) {
        change(event.target);
        baselines.delete(event.target);
      }
    };
    const changed = (event: Event) => {
      if (field(event.target)) change(event.target);
    };
    const click = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      for (const target of baselines.keys()) change(target);
      const target = event.target.closest('button,a,summary,[role="button"]');
      if (target && !target.closest('[data-no-audit]'))
        add({
          kind: target.closest('nav') ? 'ui.navigate' : 'ui.click',
          target: identity(target),
          summary: 'Нажатие: ' + title(target),
          context: context(),
        });
    };
    const drop = (event: Event) => {
      if (event.target instanceof Element)
        add({
          kind: 'ui.click',
          target: identity(event.target.closest('[data-block-id]') || event.target),
          summary: 'Перемещён блок перетаскиванием',
          context: context(),
        });
    };
    const hide = () => {
      for (const target of baselines.keys()) change(target);
      void flush();
    };
    document.addEventListener('focusin', focus, true);
    document.addEventListener('beforeinput', focus, true);
    document.addEventListener('input', input, true);
    document.addEventListener('change', changed, true);
    document.addEventListener('focusout', blur, true);
    document.addEventListener('click', click, true);
    document.addEventListener('drop', drop, true);
    window.addEventListener('pagehide', hide);
    const interval = setInterval(() => {
      for (const target of baselines.keys()) if (!target.isConnected) change(target);
      void flush();
    }, 1000);
    return () => {
      hide();
      closed = true;
      clearInterval(interval);
      for (const timer of timers.values()) clearTimeout(timer);
      document.removeEventListener('focusin', focus, true);
      document.removeEventListener('beforeinput', focus, true);
      document.removeEventListener('input', input, true);
      document.removeEventListener('change', changed, true);
      document.removeEventListener('focusout', blur, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('drop', drop, true);
      window.removeEventListener('pagehide', hide);
    };
  }, [enabled, endpoint]);
  return error;
}
