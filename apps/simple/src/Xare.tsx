import { useEffect, useRef, type ReactNode } from 'react';
import { CLIENT_CONFIG } from '@wexare/web/src/lib/client-config.ts';
import { Command } from './Command.tsx';
import { relays, trust } from './engine.ts';
import { StageStrip } from './Train.tsx';

// "Xare your model": how a model gets into this catalog, in a few steps on the
// publisher's computer. The commands are the real CLI's (apps/cli); the
// starter file is public/starter-model.json, which apps/cli/test checks the
// CLI accepts. A deployed app lists approved publishers only, so there it
// ends with asking for approval.

const PROTOCOL_DOC = 'https://github.com/wexare-ai/modelxare/blob/main/docs/protocol.md#publisher-definition-cli-input';

const STEPS: { icon: ReactNode; title: string; line: string; body: ReactNode }[] = [
  {
    icon: <SparkIcon />,
    title: 'Train your model',
    line: 'Teach a small open model one job, then make it browser-sized.',
    body: (
      <>
        <StageStrip />
        <p className="train-go">
          <a className="pill-yellow" href="#/xare/train">
            Open the training guide <span aria-hidden="true">↗</span>
          </a>
          <span className="hint">Already have a .gguf? Go to step 2.</span>
        </p>
      </>
    ),
  },
  {
    icon: <KeyIcon />,
    title: 'Make your key',
    line: 'It signs your releases and never leaves your computer.',
    body: <Command text="pnpm cli keygen --out me.key.json" />,
  },
  {
    icon: <TagIcon />,
    title: 'Describe your model',
    line: 'Fill in the starter file: what it does, in words the router reads, and your file’s link.',
    body: <Describe />,
  },
  {
    icon: <BoxIcon />,
    title: 'Check and sign',
    line: 'Checks your link serves the exact bytes, then signs the release.',
    body: (
      <>
        <Pack />
        <Command text={'pnpm cli release prepare \\\n  --definition model.json \\\n  --key me.key.json --out out/'} />
      </>
    ),
  },
  {
    icon: <SendIcon />,
    title: 'Publish',
    line: 'Sends the signed release to the relays.',
    body: <Command text={['pnpm cli release publish', '--event out/event.json', ...relays.map((r) => `--relay ${r}`)].join(' \\\n  ')} />,
  },
  ...(trust.open
    ? []
    : [
        {
          icon: <BadgeIcon />,
          title: 'Get approved',
          line: 'This app lists approved publishers. Send us your public key.',
          body: <Approve />,
        },
      ]),
];

export function Xare({ back }: { back: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  return (
    <>
      <button className="back" onClick={back}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        All models
      </button>
      <h1 className="title" ref={heading} tabIndex={-1}>
        Xare your <em className="accent">model</em>
      </h1>
      <p className="desc">Put it in the catalog, so anyone can run it on their own device.</p>

      <ul className="needs" aria-label="You need">
        <li>
          <FileIcon />
          <span>
            An idea, or a <code>.gguf</code> model
          </span>
        </li>
        <li>
          <CloudIcon />
          <span>A place that serves it over HTTPS, like Hugging Face</span>
        </li>
        <li>
          <TerminalIcon />
          {trust.open ? (
            <span>
              This repo, with <code>pnpm infra:up</code> and <code>pnpm dev</code> running
            </span>
          ) : (
            <span>
              This repo, after <code>pnpm install</code>
            </span>
          )}
        </li>
      </ul>

      <ol className="xare-steps">
        {STEPS.map((s, i) => (
          <li key={s.title} className="xare-step">
            <span className="xare-icon" aria-hidden="true">
              {s.icon}
            </span>
            <div className="xare-body">
              <h2>
                <span className="xare-n">{i + 1}</span> {s.title}
              </h2>
              <p className="xare-line">{s.line}</p>
              {s.body}
            </div>
            <svg className="xare-arrow" viewBox="0 0 100 60" aria-hidden="true">
              <path d="M8 34 C 34 22, 60 40, 86 28 M66 12 L 88 28 L 70 48" />
            </svg>
          </li>
        ))}
      </ol>

      <section className="xare-done" aria-labelledby="done-title">
        <h2 id="done-title">{trust.open ? 'It shows up here' : 'Once approved, it shows up here'}</h2>
        <div className="xare-card" aria-hidden="true">
          <span className="model-name">My summarizer</span>
          <span className="model-status ready">New</span>
          <span className="model-desc">Writes a one-sentence summary of a short message.</span>
          <span className="model-langs">English</span>
        </div>
        <p className="xare-trust">
          <ShieldIcon /> Every browser checks each byte against your signature before it runs.
        </p>
      </section>

      <p className="xare-more">
        <a href={PROTOCOL_DOC} target="_blank" rel="noreferrer">
          Every field and option <span aria-hidden="true">↗</span>
        </a>
      </p>
    </>
  );
}

/**
 * The starter file's fields, as a label to fill in. What a model does is
 * entirely its own description: the router reads `when` to send requests to
 * it, so a new task or category needs nothing from this app.
 */
function Describe() {
  return (
    <>
      <dl className="label-card">
        <dt>name</dt>
        <dd>My summarizer</dd>
        <dt>task</dt>
        <dd className="does">
          <span>
            Summarize <code>summarization</code>
          </span>
        </dd>
        <dt>category</dt>
        <dd>
          <code>messages</code>, <code>writing</code>, <code>command-line</code>, or a new one
        </dd>
        <dt>when</dt>
        <dd>“shorten the text into a brief summary”: the router reads this to send requests your way</dd>
        <dt>answer</dt>
        <dd>
          <code>text</code>, or one <code>label</code> from your list
        </dd>
        <dt>languages</dt>
        <dd>
          <code>en</code>, <code>es</code>, …
        </dd>
        <dt>file</dt>
        <dd>
          <code>model.gguf</code>
        </dd>
        <dt>at</dt>
        <dd>
          <code>https://huggingface.co/you/model/resolve/…/model.gguf</code>
        </dd>
      </dl>
      <a className="secondary" href="./starter-model.json" download="model.json" data-testid="starter">
        Get the starter file <span aria-hidden="true">↓</span>
      </a>
    </>
  );
}

/** Your file, matched against your link, then signed. */
function Pack() {
  return (
    <div className="pack" aria-hidden="true">
      <span className="pack-file">
        <FileIcon /> model.gguf
      </span>
      <svg className="pack-arrow" viewBox="0 0 100 60">
        <path d="M8 34 C 34 22, 60 40, 86 28 M66 12 L 88 28 L 70 48" />
      </svg>
      <span className="pack-to">
        <span>Same bytes at your link</span>
        <span>Signed with your key</span>
      </span>
    </div>
  );
}

/** Your public key (never the key file), and where to send it. */
function Approve() {
  return (
    <>
      <Command text="pnpm cli pubkey --key me.key.json" />
      {CLIENT_CONFIG.approvalRequest && (
        <p className="train-go">
          <a className="pill-yellow" href={CLIENT_CONFIG.approvalRequest} target="_blank" rel="noreferrer">
            Ask for approval <span aria-hidden="true">↗</span>
          </a>
        </p>
      )}
    </>
  );
}

// Line icons with round caps and joins, drawn in currentColor so they follow the text.
const icon = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

function SparkIcon() {
  return (
    <svg {...icon}>
      <path d="M12 3c1 5 3 7 8 8-5 1-7 3-8 8-1-5-3-7-8-8 5-1 7-3 8-8z" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg {...icon}>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l8-8M16 7l3 3M14 9l2 2" />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg {...icon}>
      <path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z" />
      <circle cx="8" cy="8" r="1.5" />
    </svg>
  );
}

function BoxIcon() {
  return (
    <svg {...icon}>
      <path d="M3 7l9-4 9 4v10l-9 4-9-4z" />
      <path d="M3 7l9 4 9-4M12 11v10" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg {...icon}>
      <path d="M21 3L10 14M21 3l-7 18-4-7-7-4z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg {...icon} className="i">
      <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

function BadgeIcon() {
  return (
    <svg {...icon}>
      <path d="M12 3l2.4 1.8 3 .1.9 2.9 2.4 1.8-.9 2.9.9 2.9-2.4 1.8-.9 2.9-3 .1L12 21l-2.4-1.8-3-.1-.9-2.9L3.3 14.4l.9-2.9-.9-2.9 2.4-1.8.9-2.9 3-.1z" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </svg>
  );
}

function CloudIcon() {
  return (
    <svg {...icon} className="i">
      <path d="M7 18a4 4 0 0 1-.5-8 6 6 0 0 1 11.5 1.5A3.5 3.5 0 0 1 17.5 18z" />
      <path d="M12 11v5M9.5 13.5 12 16l2.5-2.5" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg {...icon} className="i">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg {...icon} className="i">
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </svg>
  );
}
