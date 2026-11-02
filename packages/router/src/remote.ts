// Optional online help through an OpenAI-compatible chat API (OpenRouter,
// OpenAI, or any compatible endpoint). Used only for steps no local model can
// do, and only when the person turned it on with their own key. The key goes
// in the Authorization header and nowhere else: never into errors or logs.
import type { Intent } from './intents.ts';
import type { RemoteHelp } from './router.ts';

export type ProviderId = 'openrouter' | 'openai' | 'custom';

export interface Provider {
  label: string;
  baseUrl: string;
  /** Suggested model; empty when the person must name one. */
  defaultModel: string;
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openrouter/auto' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', defaultModel: '' },
  custom: { label: 'Other (OpenAI-compatible)', baseUrl: '', defaultModel: '' },
};

export interface RemoteSettings {
  enabled: boolean;
  provider: ProviderId;
  /** Used for `custom`; the presets carry their own. */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const REMOTE_OFF: RemoteSettings = { enabled: false, provider: 'openrouter', baseUrl: '', apiKey: '', model: PROVIDERS.openrouter.defaultModel };

/** Why online help can't be used yet, or null when it can. */
export function remoteProblem(s: RemoteSettings): string | null {
  if (!s.enabled) return 'online help is off';
  if (!s.apiKey.trim()) return 'add an API key';
  if (!s.model.trim()) return 'name a model';
  const base = endpoint(s);
  if (!/^https:\/\/[^\s/]+/.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(base)) return 'the address must start with https://';
  return null;
}

const endpoint = (s: RemoteSettings) => (s.provider === 'custom' ? s.baseUrl : PROVIDERS[s.provider].baseUrl).trim().replace(/\/+$/, '');

type Content = string | { type?: string; text?: string }[] | null | undefined;
const textOf = (c: Content) => (typeof c === 'string' ? c : (c ?? []).map((p) => p.text ?? '').join(''));

/** Online help for the router, or null when settings don't allow it. */
export function remoteHelp(s: RemoteSettings, fetchImpl: typeof fetch = (...a) => fetch(...a)): RemoteHelp | null {
  if (remoteProblem(s)) return null;
  const base = endpoint(s);
  const host = new URL(base).host;
  const label = s.provider === 'custom' ? host : PROVIDERS[s.provider].label;
  return {
    provider: label,
    model: s.model.trim(),
    async run(intent: Intent, request: string, context: string[], signal?: AbortSignal): Promise<string> {
      const system = context.length ? `${intent.instruction}\n\nAlready done for this request:\n${context.join('\n')}` : intent.instruction;
      let res: Response;
      try {
        res = await fetchImpl(`${base}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${s.apiKey.trim()}`,
            ...(s.provider === 'openrouter' ? { 'X-Title': 'weXare' } : {}),
          },
          body: JSON.stringify({
            model: s.model.trim(),
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: request },
            ],
            temperature: 0.2,
            max_tokens: 500,
          }),
          ...(signal ? { signal } : {}),
          credentials: 'omit',
        });
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        throw new Error(`could not reach ${label}`);
      }
      if (!res.ok) throw new Error(failure(res.status, label));
      const body = (await res.json().catch(() => null)) as { choices?: { message?: { content?: Content } }[] } | null;
      const text = textOf(body?.choices?.[0]?.message?.content).trim();
      if (!text) throw new Error(`${label} returned an empty answer`);
      return text;
    },
  };
}

function failure(status: number, label: string): string {
  if (status === 401 || status === 403) return `${label} refused the API key`;
  if (status === 402) return `${label} says the account has no credit left`;
  if (status === 404) return `${label} does not know this model`;
  if (status === 429) return `${label} is limiting requests; try again in a moment`;
  if (status >= 500) return `${label} had a problem (HTTP ${status}); try again later`;
  return `${label} rejected the request (HTTP ${status})`;
}
