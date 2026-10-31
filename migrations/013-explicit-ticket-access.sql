-- Preserve the effective pre-1.3 Ticket access on existing installations only.
-- Fresh databases have no settings row yet and start without configured Ticket roles.
INSERT INTO module_config(id,document,version)
SELECT 'tickets', json_object(
  'enabled', json('false'),
  'fullRoleId', '1565440922336886876',
  'viewRoleId', '1565620276916658276',
  'staffChannelId', NULL,
  'panel', json('[{"id":"ticket-panel","type":"text","content":"# Поддержка\nВыберите категорию обращения."}]'),
  'categories', json('[]')
), 1
FROM settings WHERE id=1
ON CONFLICT(id) DO NOTHING;

UPDATE module_config
SET document=json_set(document,
  '$.fullRoleId', CASE WHEN json_type(document,'$.fullRoleId') IS NULL THEN '1565440922336886876' ELSE json_extract(document,'$.fullRoleId') END,
  '$.viewRoleId', CASE WHEN json_type(document,'$.viewRoleId') IS NULL THEN '1565620276916658276' ELSE json_extract(document,'$.viewRoleId') END
), version=version+1
WHERE id='tickets' AND (
  json_type(document,'$.fullRoleId') IS NULL OR json_type(document,'$.viewRoleId') IS NULL
);
