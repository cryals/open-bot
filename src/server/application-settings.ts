import type { Config } from './config.js';
import type { Store } from './store.js';
import { ModuleStore } from './module-store.js';
import { applicationSettingsSchema, defaultApplicationSettings } from '../shared/settings.js';
const initialized = new WeakSet<Store>();

/** ENV values are a one-time migration input. SQLite is authoritative afterwards. */
export class ApplicationSettingsStore {
  private modules: ModuleStore;
  constructor(
    private store: Store,
    private config: Config,
  ) {
    this.modules = new ModuleStore(store);
    if (initialized.has(store)) return;
    const legacy = {
      ...defaultApplicationSettings,
      errorChannelId: config.logChannelId || null,
      gateway: config.gateway || {
        ...defaultApplicationSettings.gateway,
        messages: !!config.ticketEnabled,
        messageContent: !!config.ticketEnabled,
      },
      metricsEnabled: !!config.metricsEnabled,
      gameServerHosts: config.gameServerHosts || [],
      watchdogHosts: config.watchdogHosts || [],
    };
    store.sqlite
      .prepare('INSERT INTO module_config(id,document,version) VALUES(?,?,1) ON CONFLICT(id) DO NOTHING')
      .run('application', JSON.stringify(applicationSettingsSchema.parse(legacy)));
    initialized.add(store);
  }
  get() {
    return this.modules.get('application', applicationSettingsSchema, defaultApplicationSettings);
  }
  save(document: unknown, version: number) {
    return this.modules.save('application', applicationSettingsSchema, document, version);
  }
  applyLive() {
    const { document } = this.get();
    this.config.logChannelId = document.errorChannelId;
    this.config.gameServerHosts = document.gameServerHosts;
    this.config.watchdogHosts = document.watchdogHosts;
    this.config.metricsEnabled = document.metricsEnabled;
    return document;
  }
  applyStartup() {
    const document = this.applyLive();
    this.config.gateway = document.gateway;
    this.config.ticketEnabled = document.gateway.messages && document.gateway.messageContent;
  }
  appliedGateway() {
    const row = this.store.sqlite
      .prepare("SELECT document FROM module_config WHERE id='gateway-applied'")
      .get() as { document: string } | undefined;
    return row ? applicationSettingsSchema.shape.gateway.parse(JSON.parse(row.document)) : null;
  }
  markGatewayApplied() {
    this.store.sqlite
      .prepare(
        "INSERT INTO module_config(id,document,version) VALUES('gateway-applied',?,1) ON CONFLICT(id) DO UPDATE SET document=excluded.document,version=version+1",
      )
      .run(JSON.stringify(this.config.gateway));
  }
}
