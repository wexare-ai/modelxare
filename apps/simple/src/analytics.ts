// Usage events for Vercel Analytics. Each carries at most two properties (the
// Pro plan's limit) and only catalog facts: model names, task IDs, outcomes.
// Never what people type, and never an answer.
import { track } from '@vercel/analytics/react';

/** Vercel caps names, keys and values at 255 characters. */
const short = (s: string) => s.slice(0, 255);

/** A finished Ask: how it ended ('done', 'unsure', a problem…) and which tasks ran. */
export const trackAsk = (outcome: string, tasks: string[] = []) => track('Ask', { outcome, tasks: short(tasks.join(',') || 'none') });

/** A model page opened, by the model's catalog name. */
export const trackOpenModel = (model: string) => track('Open model', { model: short(model) });

/** Files fetched for a model (only when something was really downloaded). */
export const trackDownload = (model: string, from: 'ask' | 'model page') => track('Download', { model: short(model), from });
