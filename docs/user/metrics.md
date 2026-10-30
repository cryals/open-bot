# Prometheus и Grafana

Используются существующие Prometheus и Grafana. Open Bot предоставляет отдельный защищённый HTTP endpoint; новые контейнеры мониторинга не нужны.

```dotenv
METRICS_ENABLED=true
METRICS_HOST=127.0.0.1
METRICS_PORT=9091
METRICS_TOKEN=случайный_секрет_длиной_не_менее_32_символов
```

Перезапустите службу. Prometheus обращается к `http://127.0.0.1:9091/metrics` с заголовком `Authorization: Bearer <METRICS_TOKEN>`. Токен храните в secret-файле Prometheus. Пример конфигурации: [monitoring/prometheus.example.yml](https://github.com/cryals/open-bot/blob/main/monitoring/prometheus.example.yml).

В Compose exporter слушает `0.0.0.0` внутри контейнера, а host-порт по умолчанию привязан к `127.0.0.1`. Если Prometheus находится на другой машине, организуйте доступ через свою закрытую сеть и нужный bind address; не передавайте bearer token по открытой сети без TLS.

## Dashboard

В разделе **Метрики** скачайте JSON либо возьмите [готовый dashboard](https://github.com/cryals/open-bot/blob/main/public/monitoring/grafana.json). В Grafana откройте **Dashboards → New → Import**, загрузите JSON и выберите существующий Prometheus datasource.

Dashboard содержит обращения и время ответа поддержки, операции и задержки бота, HTTP-запросы, ошибки, возраст снимков workers и очереди. Команда `/metrics` показывает состояние конфигурации без вывода токена.

## Как читать данные

Bot, Web и exporter работают в отдельных процессах. Снимки публикуются каждые 10 секунд; exporter не вызывает Discord. Устаревший снимок старше 30 секунд исключается, возраст недоступного worker показывается как 999 секунд. Настройте alert на возраст снимка и `up` scrape target.

Счётчики использования процесса сбрасываются при его перезапуске. Общие числа созданных/закрытых тикетов и суммы времени ответа/решения хранятся в SQLite и сохраняются после удаления 180-дневного архива. ID пользователей, тикетов, каналов и тексты не используются как labels.

Endpoint возвращает 401 без правильного токена и 503 при ошибке сбора. Его сбой не останавливает Bot и Web workers. Описание метрик и интеграции: [телеметрия](../developer/telemetry.md).
