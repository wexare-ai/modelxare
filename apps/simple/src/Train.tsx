import { useEffect, useRef, type ReactNode } from 'react';
import { Command } from './Command.tsx';

// "Train your own model": the nine stages from an idea to a model this app can
// run, each with one line, a picture and the common tools for it. modelXare
// runs GGUF files with wllama (llama.cpp), so the guide ends in GGUF.

type Tool = { name: string; href: string; note?: string };

export const STAGES: { id: string; title: string; line: string; visual?: ReactNode; command?: string; tools: Tool[]; more?: ReactNode; aside?: ReactNode }[] = [
  {
    id: 'spec',
    title: 'Pick one job',
    line: 'One task, what goes in, what comes out, and a small base model.',
    visual: <Spec />,
    tools: [
      { name: 'SmolLM2 360M', href: 'https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct' },
      { name: 'Qwen2.5 0.5B', href: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct' },
      { name: 'Gemma 3 270M', href: 'https://huggingface.co/google/gemma-3-270m-it' },
    ],
  },
  {
    id: 'data',
    title: 'Collect examples',
    line: 'A thousand or more chats showing the job done right. Keep some aside for testing.',
    visual: <Data />,
    tools: [
      { name: 'Chat data format', href: 'https://huggingface.co/docs/trl/dataset_formats' },
      { name: 'Datasets', href: 'https://huggingface.co/docs/datasets' },
    ],
    more: <Distill />,
  },
  {
    id: 'train',
    title: 'Train an adapter',
    line: 'LoRA teaches a small add-on while the base model stays frozen. QLoRA does it on a 4-bit base, in less memory.',
    visual: <Adapter />,
    tools: [
      { name: 'Unsloth', note: 'free Colab notebooks', href: 'https://github.com/unslothai/unsloth' },
      { name: 'TRL + PEFT', note: 'NVIDIA GPU', href: 'https://huggingface.co/docs/trl/sft_trainer' },
      { name: 'MLX-LM', note: 'Apple Silicon Mac', href: 'https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/LORA.md' },
    ],
  },
  {
    id: 'eval',
    title: 'Test it',
    line: 'Run the examples it never saw. Go on only if it beats the base model.',
    visual: <Score />,
    tools: [
      { name: 'Evaluate', href: 'https://huggingface.co/docs/evaluate' },
      { name: 'lm-evaluation-harness', href: 'https://github.com/EleutherAI/lm-evaluation-harness' },
    ],
  },
  {
    id: 'fuse',
    title: 'Fuse',
    line: 'Merge the adapter into the base, so it is one model again.',
    visual: <Fuse />,
    tools: [
      { name: 'PEFT: merge_and_unload', href: 'https://huggingface.co/docs/peft/developer_guides/lora' },
      { name: 'MLX-LM: mlx_lm.fuse', href: 'https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/LORA.md' },
    ],
    aside: (
      <>
        Or keep the adapter on its own: convert it with <code>convert_lora_to_gguf.py</code> and modelXare runs it on its base model.
      </>
    ),
  },
  {
    id: 'export',
    title: 'Export to GGUF',
    line: 'One file, the format llama.cpp runs, in a browser too.',
    visual: <Export />,
    command: 'python convert_hf_to_gguf.py fused/ \\\n  --outtype f16 --outfile model-f16.gguf',
    tools: [
      { name: 'llama.cpp', href: 'https://github.com/ggml-org/llama.cpp' },
      { name: 'GGUF-my-repo', note: 'no install', href: 'https://huggingface.co/spaces/ggml-org/gguf-my-repo' },
    ],
  },
  {
    id: 'quantize',
    title: 'Shrink it',
    line: 'Fewer bits per weight: a smaller download, nearly the same answers.',
    visual: <Sizes />,
    command: 'llama-quantize model-f16.gguf model.gguf Q8_0',
    tools: [{ name: 'Quantize guide', href: 'https://github.com/ggml-org/llama.cpp/blob/master/tools/quantize/README.md' }],
  },
  {
    id: 'tokenizer',
    title: 'Check the tokenizer',
    line: 'The file must carry its tokenizer and chat template, or answers come out garbled.',
    visual: <Inside />,
    command: 'pip install gguf\ngguf-dump model.gguf | grep chat_template',
    tools: [{ name: 'GGUF on Hugging Face', href: 'https://huggingface.co/docs/hub/gguf' }],
  },
  {
    id: 'web',
    title: 'Run it in a browser',
    line: 'Try it with wllama, the engine modelXare uses. Then share it.',
    visual: <Browser />,
    tools: [{ name: 'wllama', href: 'https://github.com/ngxson/wllama' }],
  },
];

export function Train({ back }: { back: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const goTo = (id: string) => document.getElementById(`stage-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <>
      <button className="back" onClick={back}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Xare your model
      </button>
      <h1 className="title" ref={heading} tabIndex={-1}>
        Train your <em className="accent">own</em> model
      </h1>
      <p className="desc">Teach a small open model one job, then make it small enough for a browser.</p>
      <ul className="needs" aria-label="You need">
        <li>Python 3</li>
        <li>A GPU, an Apple Silicon Mac, or a free Colab notebook</li>
      </ul>

      <ol className="stage-map" aria-label="Stages">
        {STAGES.map((s, i) => (
          <li key={s.id}>
            <button onClick={() => goTo(s.id)}>
              <span className="stage-n">{i + 1}</span> {s.id}
            </button>
          </li>
        ))}
      </ol>

      <div className="stages">
        {STAGES.map((s, i) => (
          <section key={s.id} id={`stage-${s.id}`} className="stage" aria-labelledby={`stage-${s.id}-title`} data-testid="stage">
            <span className="tag">
              {i + 1} · {s.id}
            </span>
            <h2 id={`stage-${s.id}-title`}>{s.title}</h2>
            <p className="xare-line">{s.line}</p>
            {s.visual}
            {s.command && <Command text={s.command} />}
            <p className="tools">
              {s.tools.map((t) => (
                <a key={t.href + t.name} className="tool" href={t.href} target="_blank" rel="noreferrer">
                  {t.name}
                  {t.note && <small>{t.note}</small>}
                  <span aria-hidden="true">↗</span>
                </a>
              ))}
            </p>
            {s.more}
            {s.aside && <p className="stage-aside">{s.aside}</p>}
          </section>
        ))}
      </div>

      <div className="train-next">
        <p>
          Your <code>model.gguf</code> is ready.
        </p>
        <a className="pill-yellow" href="#/xare">
          Xare it <span aria-hidden="true">↗</span>
        </a>
      </div>
    </>
  );
}

/** The nine stages as a small strip, for the Xare page's first step. */
export function StageStrip() {
  return (
    <ol className="stage-map compact" aria-label="Stages">
      {STAGES.map((s) => (
        <li key={s.id}>{s.id}</li>
      ))}
    </ol>
  );
}

// ───────────── Pictures ─────────────

function Spec() {
  return (
    <dl className="label-card" aria-label="Example">
      <dt>job</dt>
      <dd>Sort a message by topic</dd>
      <dt>in</dt>
      <dd>“Your order has shipped and arrives Wednesday.”</dd>
      <dt>out</dt>
      <dd className="does">
        <span>shopping</span>
        <span>travel</span>
        <span>money</span>
        <span>…</span>
      </dd>
      <dt>base</dt>
      <dd>a small instruct model, 135M to 1B</dd>
    </dl>
  );
}

function Data() {
  return (
    <div className="pic" aria-hidden="true">
      <div className="chat">
        <span className="bubble system">Sort the message into one topic.</span>
        <span className="bubble user">Your order has shipped and arrives Wednesday.</span>
        <span className="bubble ai">shopping</span>
      </div>
      <div className="split">
        <span style={{ flex: 8 }}>train</span>
        <span style={{ flex: 1 }}>valid</span>
        <span style={{ flex: 1 }}>test</span>
      </div>
    </div>
  );
}

/** No data yet: have a large model write it (distillation), then check it. */
function Distill() {
  return (
    <div className="distill" data-testid="distill">
      <h3>No examples yet? Generate them</h3>
      <p className="xare-line">A large model writes the chats; your small model learns from them.</p>
      <ol className="pic flow" aria-hidden="true">
        <li className="block prompt">your prompt</li>
        <li className="block frontier">
          <span>
            <SparkIcon /> large model
          </span>
        </li>
        <li className="block chats">
          thousands of chats
          <small>JSON lines</small>
        </li>
        <li className="block checked">
          check
          <small>format · repeats · balance</small>
        </li>
      </ol>
      <p className="prompt-card">
        Write 50 short texts and emails people get every day. Vary the tone, length and typos. Label each one: family, work, money, shopping or travel. One JSON
        line per message.
      </p>
      <p className="tools">
        <a className="tool" href="https://github.com/argilla-io/distilabel" target="_blank" rel="noreferrer">
          distilabel <span aria-hidden="true">↗</span>
        </a>
        <a className="tool" href="https://github.com/bespokelabsai/curator" target="_blank" rel="noreferrer">
          Curator <span aria-hidden="true">↗</span>
        </a>
      </p>
      <p className="stage-aside">Check the test examples by hand, and that the large model’s terms allow training on its answers.</p>
    </div>
  );
}

function Adapter() {
  return (
    <div className="pic blocks" aria-hidden="true">
      <span className="block base">
        <LockIcon /> base model
        <small>frozen</small>
      </span>
      <span className="plus">+</span>
      <span className="block adapter">
        adapter
        <small>learns</small>
      </span>
    </div>
  );
}

function Score() {
  const row = (marks: string) =>
    [...marks].map((m, i) => (
      <span key={i} className={m === '1' ? 'mark ok' : 'mark no'}>
        {m === '1' ? '✓' : '✗'}
      </span>
    ));
  return (
    <div className="pic score" aria-hidden="true">
      <span className="score-who">base</span>
      <span className="marks">{row('100100')}</span>
      <span className="score-who">yours</span>
      <span className="marks">{row('111110')}</span>
    </div>
  );
}

function Fuse() {
  return (
    <div className="pic blocks" aria-hidden="true">
      <span className="block base">base model</span>
      <span className="plus">+</span>
      <span className="block adapter">adapter</span>
      <Arrow />
      <span className="block yours">your model</span>
    </div>
  );
}

function Export() {
  return (
    <div className="pic blocks" aria-hidden="true">
      <span className="block folder">
        fused/
        <small>many files</small>
      </span>
      <Arrow />
      <span className="block file">
        model-f16.gguf
        <small>one file</small>
      </span>
    </div>
  );
}

function Sizes() {
  return (
    <div className="pic sizes" aria-hidden="true">
      <span className="size" style={{ width: '100%' }}>
        F16 <small>full size</small>
      </span>
      <span className="size" style={{ width: '53%' }}>
        Q8_0 <small>about half</small>
      </span>
      <span className="size" style={{ width: '32%' }}>
        Q4_K_M <small>a third</small>
      </span>
    </div>
  );
}

function Inside() {
  return (
    <div className="pic gguf" aria-hidden="true">
      <span className="gguf-name">model.gguf</span>
      <span className="gguf-part">weights</span>
      <span className="gguf-part">tokenizer</span>
      <span className="gguf-part">chat template</span>
    </div>
  );
}

function Browser() {
  return (
    <div className="pic browser" aria-hidden="true">
      <span className="browser-bar">
        <i />
        <i />
        <i />
        <span>modelXare</span>
      </span>
      <span className="browser-body">
        <span className="bubble user">Your order has shipped and arrives Wednesday.</span>
        <span className="bubble ai">shopping</span>
      </span>
    </div>
  );
}

function Arrow() {
  return (
    <svg className="pack-arrow" viewBox="0 0 100 60">
      <path d="M8 34 C 34 22, 60 40, 86 28 M66 12 L 88 28 L 70 48" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg className="i" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 3c1 5 3 7 8 8-5 1-7 3-8 8-1-5-3-7-8-8 5-1 7-3 8-8z" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
