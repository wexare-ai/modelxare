// What a request can ask for. System 1 chooses among these by their plain
// descriptions; `capability` names the bundled operation a local mini-model
// needs to do it. Intents without one are only possible with online help.

export interface Intent {
  id: string;
  /** How System 1 sees this option: one short, plain description. */
  criterion: string;
  /** Bundled operation (catalog capability) a local model must offer to do this. */
  capability?: string;
  /** System instruction for an online model. */
  instruction: string;
}

export const INTENTS: Intent[] = [
  {
    id: 'sort',
    criterion: 'put the message into one topic category, such as maintenance, safety, security, noise or cleanliness',
    capability: 'text-classification',
    instruction: 'Classify the message into exactly one of: maintenance, safety, security, noise, cleanliness, other. Reply with the category only.',
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
];

/** The extra option offered after the first step: nothing more to do. */
export const DONE = 'done';
export const DONE_CRITERION = 'nothing else: every part of the request has been handled';
