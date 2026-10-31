# Prometheus и Grafana

![Metrics — иллюстрация модуля](../assets/modules/metrics.png)

Используются существующие Prometheus и Grafana. Open Bot предоставляет отдельный защищённый HTTP endpoint; новые контейнеры мониторинга не нужны.

```dotenv
METRICS_HOST=127.0.0.1
METRICS_PORT=9091
METRICS_TOKEN=случайный_секрет_длиной_не_менее_32_символов
```

После добавления секрета перезапустите службу и включите exporter в **Настройки → Настройки приложения**. Дальнейшее включение/выключение выполняется в панели. Prometheus обращается к `http://127.0.0.1:9091/metrics` с заголовком `Authorization: Bearer <METRICS_TOKEN>`. Токен храните в secret-файле Prometheus. Пример конфигурации: [monitoring/prometheus.example.yml](https://github.com/cryals/open-bot/blob/main/monitoring/prometheus.example.yml).

В Compose exporter слушает `0.0.0.0` внутри контейнера, а host-порт по умолчанию привязан к `127.0.0.1`. Если Prometheus находится на другой машине, организуйте доступ через свою закрытую сеть и нужный bind address; не передавайте bearer token по открытой сети без TLS.

## Dashboard

В разделе **Метрики** скачайте JSON либо возьмите [готовый dashboard](https://github.com/cryals/open-bot/blob/main/public/monitoring/grafana.json). В Grafana откройте **Dashboards → New → Import**, загрузите JSON и выберите существующий Prometheus datasource.

Dashboard содержит обращения и время ответа поддержки, операции и задержки бота, HTTP-запросы, ошибки, возраст снимков workers и очереди. Команда `/metrics` показывает состояние конфигурации без вывода токена.

## Как читать данные

Bot, Web и exporter работают в отдельных процессах. Снимки публикуются каждые 10 секунд; exporter не вызывает Discord. Устаревший снимок старше 30 секунд исключается, возраст недоступного worker показывается как 999 секунд. Настройте alert на возраст снимка и `up` scrape target.

Счётчики использования процесса сбрасываются при его перезапуске. Общие числа созданных/закрытых тикетов и суммы времени ответа/решения хранятся в SQLite и сохраняются после удаления 180-дневного архива. ID пользователей, тикетов, каналов и тексты не используются как labels.

Endpoint возвращает 401 без правильного токена и 503 при ошибке сбора. Его сбой не останавливает Bot и Web workers. Описание метрик и интеграции: [телеметрия](../developer/telemetry.md).

## Игровые серверы и новые панели

Dashboard версии 3 содержит 32 панели: дополнительно — состояния и онлайн по играм, p95 и ошибки query, возраст статуса, Discord Gateway/heartbeat, просроченные задания, возраст очередей, размер SQLite/WAL, копии сервера, восстановления, розыгрыши и действия Watchdog.

Метрики Game Server Status сгруппированы по `game`, без адресов, ID серверов и игроков. Подробный отдельный сервер смотрите в панели или через `/server-status`. `unknown` означает отсутствие свежих данных (150 секунд) или изменение конфигурации. Offline — свежий неуспешный query, а не отсутствие данных. Кешированные чтения не увеличивают счётчики запросов.

| Метрика                                                          | Значение                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `open_bot_game_servers{game,state}`                              | Число online/offline/unknown серверов.                                         |
| `open_bot_game_servers_configured`                               | Число настроенных серверов каждой игры.                                        |
| `open_bot_game_players`, `open_bot_game_capacity`                | Онлайн и вместимость свежих доступных серверов.                                |
| `open_bot_game_player_samples`                                   | Число серверов, действительно сообщивших онлайн.                               |
| `open_bot_game_probes_total{game,outcome}`                       | Фактические запросы status. Сбрасывается с worker.                             |
| `open_bot_game_probe_duration_seconds`                           | Histogram времени query.                                                       |
| `open_bot_game_oldest_sample_age_seconds`                        | Возраст самой старой выборки; 999, если выборки ещё не было.                   |
| `open_bot_gateway_connected`, `open_bot_gateway_latency_seconds` | Подключение Discord и последний heartbeat. Задержка актуальна при подключении. |
| `open_bot_job_oldest_pending_age_seconds`                        | Возраст просроченного задания по типу.                                         |
| `open_bot_database_size_bytes{file}`                             | Размер файла SQLite и WAL.                                                     |
| `open_bot_exporter_collection_duration_seconds`                  | Время локального сбора метрик.                                                 |

Exporter не опрашивает игры или Discord: читает SQLite и worker snapshots. Ответ `/metrics` кешируется на 5 секунд; параллельные scrape используют один сбор. Старые worker snapshots по-прежнему исключаются после 30 секунд.

## Оповещения

Готовые примеры правил: [monitoring/alerts.example.yml](https://github.com/cryals/open-bot/blob/main/monitoring/alerts.example.yml). Подключите файл через `rule_files` существующего Prometheus и настройте Alertmanager. Включены недоступность exporter, отсутствие worker/Gateway, offline/unknown серверы, просроченные задания, очередь ошибок и отсутствие плановой копии. Для последнего правила расписание должно быть включено; порог — 25 часов. Эти примеры не меняют настройки вашей Grafana или Prometheus автоматически.
