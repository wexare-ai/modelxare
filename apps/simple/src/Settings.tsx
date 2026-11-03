import { useState } from 'react';
import { PROVIDERS, remoteProblem, type ProviderId, type RemoteSettings } from '@wexare/router';
import { SPACE_LIMITS, setSpaceLimit, useSpace } from './engine.ts';
import { size } from './models.ts';
import { loadOnlineHelp, saveOnlineHelp, useRouterModel } from './routing.ts';

const PROBLEM: Record<string, string> = {
  'add an API key': 'Add your API key to turn online help on.',
  'name a model': 'Name the model to use.',
  'the address must start with https://': 'The address must start with https://.',
};

export function Settings({ back }: { back: () => void }) {
  const [form, setForm] = useState<RemoteSettings>(loadOnlineHelp);
  const [saved, setSaved] = useState(false);
  const router = useRouterModel();
  const space = useSpace();
  const limits = SPACE_LIMITS.includes(space.limit) ? SPACE_LIMITS : [...SPACE_LIMITS, space.limit].sort((a, b) => a - b);
  const set = (patch: Partial<RemoteSettings>) => {
    setSaved(false);
    setForm((f) => ({ ...f, ...patch }));
  };
  const problem = form.enabled ? remoteProblem(form) : null;
  const provider = form.provider === 'custom' ? 'that service' : PROVIDERS[form.provider].label;

  return (
    <>
      <button className="back" onClick={back}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Back
      </button>
      <h1 className="title">Settings</h1>

      <section className="settings" aria-labelledby="help-title">
        <h2 id="help-title">Online help</h2>
        <p>
          When no model on this device can do a step, modelXare can ask an online AI service you choose, with your own account. Models on this device are always tried
          first.
        </p>
        <label className="check">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} data-testid="help-enabled" />
          Use online help
        </label>
        <fieldset disabled={!form.enabled}>
          <label>
            Service
            <select
              value={form.provider}
              onChange={(e) => {
                const id = e.target.value as ProviderId;
                set({ provider: id, model: PROVIDERS[id].defaultModel || (form.provider === id ? form.model : '') });
              }}
            >
              {(Object.keys(PROVIDERS) as ProviderId[]).map((id) => (
                <option key={id} value={id}>
                  {PROVIDERS[id].label}
                </option>
              ))}
            </select>
          </label>
          {form.provider === 'custom' && (
            <label>
              Address
              <input value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://example.com/v1" spellCheck={false} />
            </label>
          )}
          <label>
            API key
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => set({ apiKey: e.target.value })}
              autoComplete="off"
              spellCheck={false}
              data-testid="help-key"
            />
            <small>Kept only in this browser.</small>
          </label>
          <label>
            Model
            <input
              value={form.model}
              onChange={(e) => set({ model: e.target.value })}
              placeholder={form.provider === 'openai' ? 'for example, the name of a chat model in your account' : 'model name'}
              spellCheck={false}
              data-testid="help-model"
            />
          </label>
        </fieldset>
        <div className="actions">
          <button
            className="primary"
            onClick={() => {
              saveOnlineHelp(form);
              setSaved(true);
            }}
            data-testid="help-save"
          >
            Save
          </button>
          <span className="hint" role="status">
            {problem ? PROBLEM[problem] ?? problem : saved ? (form.enabled ? 'Saved. Online help is on.' : 'Saved. Online help is off.') : ''}
          </span>
        </div>
        {form.enabled && <p className="hint">With online help on, the text of those steps is sent to {provider}. Nothing else leaves this device.</p>}
      </section>

      <section className="settings" aria-labelledby="router-title">
        <h2 id="router-title">Router</h2>
        <p>A model that works out what each request needs and which model should do it. It runs on this device and never sends your text anywhere.</p>
        <p data-testid="router-status">
          {router.status === 'missing' || router.status === 'unknown'
            ? 'Not available yet.'
            : router.status === 'not-downloaded'
              ? `Not downloaded (${size(router.totalBytes)}). It downloads the first time you ask for something.`
              : `${size(router.totalBytes)}, saved on this device.`}
        </p>
        {(router.status === 'downloaded' || router.status === 'ready') && (
          <button className="secondary" onClick={() => void router.remove()}>
            Remove from this device
          </button>
        )}
      </section>

      <section className="settings" aria-labelledby="space-title">
        <h2 id="space-title">Space</h2>
        <p>
          Models are saved on this device, so they start faster and work offline. When a new model needs room, the ones you haven’t used for the longest are removed.
          They download again if you need them.
        </p>
        <label>
          Space for models
          <select value={space.limit} onChange={(e) => void setSpaceLimit(Number(e.target.value))} data-testid="space-limit">
            {limits.map((l) => (
              <option key={l} value={l}>
                {l % 1e9 === 0 ? `${l / 1e9} GB` : size(l)}
              </option>
            ))}
          </select>
        </label>
        <p className="hint" data-testid="space-status">
          {space.saved === null ? '' : space.saved === 0 ? 'No models saved yet.' : `Saved models take ${size(space.saved)}.`}
        </p>
      </section>
    </>
  );
}
