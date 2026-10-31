import { useEffect, useState } from 'react';
import { api, setCsrf } from './api.js';
import type { formSchema } from '../shared/community.js';
import type { z } from 'zod';
type Form = Pick<
  z.infer<typeof formSchema>,
  'id' | 'title' | 'description' | 'anonymous' | 'retentionDays' | 'questions'
>;
export function PublicForm({ id }: { id: string }) {
  const [form, setForm] = useState<Form | null>(null),
    [answers, setAnswers] = useState<Record<string, string | string[]>>({}),
    [error, setError] = useState(''),
    [guest, setGuest] = useState(false),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<number | null>(null),
    [caseId, setCaseId] = useState('');
  useEffect(() => {
    void (async () => {
      try {
        const me = await api<{ csrf: string }>('/applicant/me');
        setCsrf(me.csrf);
        setForm(await api('/applicant/forms/' + encodeURIComponent(id)));
      } catch (error) {
        if ((error as { status?: number }).status === 401) setGuest(true);
        else setError(error instanceof Error ? error.message : 'Ошибка');
      }
    })();
  }, [id]);
  return (
    <main className="ticket-only module-workspace">
      <h1>{form?.title || 'Форма Open Bot'}</h1>
      {guest ? (
        <a className="button primary" href={'/auth/discord?form=' + encodeURIComponent(id)}>
          Войти через Discord
        </a>
      ) : null}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {result ? (
        <p role="status">Заявка #{result} отправлена.</p>
      ) : (
        form && (
          <form
            className="module-card"
            onSubmit={(event) => {
              event.preventDefault();
              setBusy(true);
              setError('');
              void api<{ id: number }>('/applicant/forms/' + encodeURIComponent(id), 'POST', {
                answers,
                caseId: caseId ? Number(caseId) : undefined,
              })
                .then((result) => setResult(result.id))
                .catch((error: Error) => setError(error.message))
                .finally(() => setBusy(false));
            }}
          >
            <p>{form.description}</p>
            <p>
              Хранение: {form.retentionDays} дней.{' '}
              {form.anonymous
                ? 'Автор скрыт от обработчиков; технический ID сохраняется для защиты от спама.'
                : ''}
            </p>
            <fieldset disabled={busy}>
              {form.questions.map((question) => (
                <label key={question.id}>
                  {question.label}
                  {question.required ? ' *' : ''}
                  {question.type === 'short' ? (
                    <input
                      required={question.required}
                      maxLength={1000}
                      value={String(answers[question.id] || '')}
                      onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })}
                    />
                  ) : question.type === 'long' ? (
                    <textarea
                      required={question.required}
                      rows={7}
                      maxLength={20000}
                      value={String(answers[question.id] || '')}
                      onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })}
                    />
                  ) : (
                    <select
                      multiple={question.type === 'multiple'}
                      required={question.required}
                      value={
                        question.type === 'multiple'
                          ? (answers[question.id] as string[]) || []
                          : String(answers[question.id] || '')
                      }
                      onChange={(event) =>
                        setAnswers({
                          ...answers,
                          [question.id]:
                            question.type === 'multiple'
                              ? Array.from(event.target.selectedOptions, (option) => option.value)
                              : event.target.value,
                        })
                      }
                    >
                      {question.type === 'single' && <option value="">Выберите вариант</option>}
                      {question.choices.map((choice) => (
                        <option key={choice} value={choice}>
                          {choice}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
              ))}
              <label>
                Номер дела (если это апелляция; необязательно)
                <input
                  type="number"
                  min={1}
                  value={caseId}
                  onChange={(event) => setCaseId(event.target.value)}
                />
              </label>
              <button className="button primary">Отправить заявку</button>
            </fieldset>
          </form>
        )
      )}
    </main>
  );
}
