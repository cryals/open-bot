# Журнал, ошибки и метрики

| Механизм        | Назначение                                     | Хранение/доставка                                                           |
| --------------- | ---------------------------------------------- | --------------------------------------------------------------------------- |
| ActivityService | Административные действия, before/after, diff  | SQLite + JSONL; необязательный Discord-канал.                               |
| ErrorReporter   | Stack/cause, ID отчёта                         | Дисковый outbox, supervisor доставляет через LOG_ID с LOG_WEBHOOK fallback. |
| Metrics         | Частоты, задержки, состояние модулей и тикетов | Снимки процессов, отдельный Prometheus exporter и Grafana dashboard.        |

## Activity

`activity.record(actor, input)` получает `userId/name`, `kind`, `target`, `summary`, необязательные `before/after/details`. Передавайте безопасную проекцию, не raw request/config. UI-клик не доказывает успех серверной операции.

Событие получает UUID и сначала атомарно сохраняется в общий локальный outbox. Только Bot consumer использует Redis Streams и фиксирует пачку до 100 событий или раз в секунду в SQLite/JSONL. ACK следует после persistence; UUID исключает повторную строку SQLite. Внешняя доставка после потери ответа может повториться. Без Redis используется та же локальная очередь и пакетная запись.

Правила, настройки, публикации, Ticket history и ID сообщений фиксируются сразу. Авторизацию не кешируют.

## Ошибки и секреты

Используйте `errors.report(error, scope, context)`, например scope `ticket.archive`. Общие обработчики команд/API уже создают отчёт — не дублируйте его при rethrow. Сбой доставки не должен рекурсивно наполнять error outbox.

В redaction входят bot/OAuth/session secrets, webhook URLs, `METRICS_TOKEN` и значения `WATCHDOG_TOKEN_*`. Новые секреты добавляйте до persistence. Не логируйте cookie, Authorization, OAuth-коды или credentials в URL. Обычные сообщения не архивируются, кроме специально включённого Ticket scope. Транскрипт помечен `data-no-audit`, чтобы переписка не попала в бессрочный UI-журнал.

## Prometheus

`telemetry.ts` содержит registry `@prometheus-io/client`. При включённом Metrics каждый worker добавляет label `worker` и записывает снимок в `metric_snapshots` раз в 10 секунд. Выделенный Metrics worker агрегирует снимки не старше 30 секунд и добавляет устойчивые Ticket aggregates/queue gauges. Он не вызывает Discord и не зависит от Web HTTP listener.

```ts
telemetry.observe('example', 'refresh', 'success', startedAtMilliseconds);
```

`module/operation/outcome` — конечные наборы. Пользовательские строки, ID, URLs и содержимое не являются labels. HTTP использует зарегистрированный маршрут, не request URL.

| Метрика                                                         | Смысл                                           |
| --------------------------------------------------------------- | ----------------------------------------------- |
| `open_bot_operations_total`                                     | Операции по module/operation/outcome.           |
| `open_bot_operation_duration_seconds`                           | Histogram задержек операций.                    |
| `open_bot_http_requests_total`                                  | HTTP по method/route/status.                    |
| `open_bot_http_duration_seconds`                                | Histogram HTTP latency.                         |
| `open_bot_errors_total`                                         | Созданные error reports.                        |
| `open_bot_module_up`                                            | 1 для работающего модуля.                       |
| `open_bot_worker_restarts`                                      | Число перезапусков worker в текущем supervisor. |
| `open_bot_worker_snapshot_age_seconds`                          | Возраст снимка; 999 при отсутствии свежего.     |
| `open_bot_tickets`                                              | Текущее число тикетов по state.                 |
| `open_bot_ticket_pending_jobs`                                  | Незавершённые lifecycle/access jobs.            |
| `open_bot_ticket_created_total`, `open_bot_ticket_closed_total` | Устойчивые суммарные числа.                     |
| `open_bot_ticket_first_responses_total`                         | Число первых ответов поддержки.                 |
| `open_bot_ticket_first_response_seconds_total`                  | Сумма времени первых ответов.                   |
| `open_bot_ticket_resolution_seconds_total`                      | Сумма времени до закрытия.                      |
| `open_bot_disk_queue_items`                                     | Число файлов очередей activity/errors.          |
| `open_bot_process_*`, `open_bot_nodejs_*`                       | Стандартные runtime metrics.                    |

Счётчики процесса обнуляются при перезапуске. Ticket totals сохраняются в SQLite независимо от удаления архива. Для среднего ответа используйте отношение приращений суммы времени и числа ответов.

Exporter слушает выделенный host/port, требует bearer token минимум 32 символа, сравнивает SHA-256 timing-safe. Защищайте транспорт закрытой сетью/TLS. [Настройка scrape и dashboard](../user/metrics.md).

При задержке audit смотрите возраст outbox и состояние consumer, не удаляйте pending-файлы. Реальному Redis regression нужен отдельный `TEST_REDIS_URL`, иначе он skipped. При недоступности exporter смотрите его worker и freshness отдельно от Bot/Web. Работающий healthcheck не доказывает успешный scrape.
