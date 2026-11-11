// What a request can ask for. System 1 picks among them by their plain
// descriptions; `capability` names the bundled operation a local mini-model
// needs to do it. Intents without one are only possible with online help.

export interface Intent {
  id: string;
  /** How System 1 sees this option among the others: one short, plain description. */
  criterion: string;
  /** Bundled operation (catalog capability) a local model must offer to do this. */
  capability?: string;
  /**
   * The models that offer `capability` are not interchangeable (one does git,
   * another ffmpeg): System 1 picks one by what each release says it is for.
   * Otherwise any of them will do, and the smallest or a downloaded one runs.
   */
  pickModel?: boolean;
  /** System instruction for an online model. */
  instruction: string;
}

export const INTENTS: Intent[] = [
  {
    id: 'sort',
    criterion: 'put the message into one topic category, such as family, work, money, shopping or travel',
    capability: 'text-classification',
    instruction: 'Sort the message into exactly one of these topics: family, friends, work, money, shopping, travel, health, home, other. Reply with the topic only.',
  },
  {
    id: 'summarize',
    criterion: 'shorten the text into a brief summary',
    capability: 'summarization',
    instruction: 'Summarize the text in one short sentence, in the language of the text. Reply with the summary only.',
  },
  {
    id: 'write',
    criterion: 'continue a story or a piece of text',
    capability: 'text-generation',
    instruction: 'Continue the text naturally for two or three sentences. Reply with the continuation only.',
  },
  {
    id: 'reply',
    criterion: 'draft a reply to the message',
    instruction: 'Draft a short, polite reply to the message. Reply with the draft only.',
  },
  {
    id: 'translate',
    criterion: 'translate the text into another language',
    instruction: 'Translate the text. If no target language is named, translate it into English. Reply with the translation only.',
  },
  {
    id: 'answer',
    criterion: 'answer a question or explain something',
    instruction: 'Answer the question clearly and briefly.',
  },
  {
    id: 'command',
    criterion: 'give the command line that does a task with a tool such as git, ffmpeg or ImageMagick',
    capability: 'command-generation',
    pickModel: true,
    instruction: 'Give the shell command that does what is asked. Reply with the command only, one command per line.',
  },
];
