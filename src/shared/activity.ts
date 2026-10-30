import { z } from 'zod';
export const uiEventSchema = z.object({
  kind: z.enum(['ui.click', 'ui.change', 'ui.navigate']),
  target: z.string().max(300),
  summary: z.string().max(300),
  context: z.string().max(300).optional(),
  occurredAt: z.number().int().positive().optional(),
  before: z.string().max(60000).optional(),
  after: z.string().max(60000).optional(),
});
export type UiEvent = z.infer<typeof uiEventSchema>;
export type ActivityEntry = {
  id: number;
  eventId: string | null;
  createdAt: number;
  actor: string;
  actorName: string;
  kind: string;
  target: string;
  summary: string;
  details: Record<string, unknown>;
  before: string | null;
  after: string | null;
  diff: string | null;
};
export type ActivityPage = {
  entries: ActivityEntry[];
  pending: number;
  deliveryError: string | null;
  fileError: string | null;
};
