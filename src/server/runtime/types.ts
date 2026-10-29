import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
} from 'discord.js';
import type { Config } from '../config.js';
import type { Store } from '../store.js';
import type { DiscordService } from '../discord.js';
import type { ActivityService } from '../activity.js';
import type { Publisher } from '../publisher.js';
import type { ErrorReporter } from './error-reporter.js';
import type { ModuleManager } from './module-manager.js';

export type ProcessState = {
  activityError?: string | null;
  pid: number | null;
  state: 'starting' | 'running' | 'restarting' | 'stopped';
  ready: boolean;
  restarts: number;
  lastBeat: number;
  modules: ModuleState[];
};
export type RuntimeStatus = { bot: ProcessState; web: ProcessState };
export type ModuleState = {
  id: string;
  title: string;
  state: 'starting' | 'running' | 'failed';
  errorId?: string;
};
export type CommandContext = { interaction: ChatInputCommandInteraction; ackMs: number; signal: AbortSignal };
export type BotCommand = {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;
  admin?: boolean;
  execute: (context: CommandContext, runtime: BotContext) => Promise<void>;
};
export type ModuleLifecycle<Context> = {
  id: string;
  title: string;
  description: string;
  dependencies?: string[];
  start?: (context: Context, signal: AbortSignal) => Promise<void>;
  stop?: (context: Context, signal: AbortSignal) => Promise<void>;
};
export type BotModule = ModuleLifecycle<BotContext> & {
  commands?: BotCommand[];
  buttons?: {
    prefix: string;
    execute: (interaction: ButtonInteraction, runtime: BotContext) => Promise<void>;
  }[];
};
export type ModuleSource = { id: string; load: () => Promise<{ default: BotModule }> };
export type BotContext = {
  config: Config;
  store: Store;
  discord: DiscordService;
  activity: ActivityService;
  publisher: Publisher;
  errors: ErrorReporter;
  manager: ModuleManager;
  status: () => RuntimeStatus;
};
