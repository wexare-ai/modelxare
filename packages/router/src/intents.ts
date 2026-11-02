// What a request can ask for. System 1 judges each one with a yes/no
// question and also picks the main one by its plain description;
// `capability` names the bundled operation a local mini-model needs to do it.
// Intents without one are only possible with online help.

export interface Intent {
  id: string;
  /** How System 1 sees this option among the others: one short, plain description. */
  criterion: string;
  /** Yes/no question: does `request` ask for this? */
  asks: string;
  /** Bundled operation (catalog capability) a local model must offer to do this. */
  capability?: string;
  /** System instruction for an online model. */
  instruction: string;
}

export const INTENTS: Intent[] = [
  {
    id: 'sort',
    criterion: 'put the message into one topic category, such as maintenance, safety, security, noise or cleanliness',
    asks: 'Does `request` ask to sort, categorize or classify a message by topic?',
    capability: 'text-classification',
    instruction: 'Classify the message into exactly one of: maintenance, safety, security, noise, cleanliness, other. Reply with the category only.',
  },
  {
    id: 'summarize',
    criterion: 'shorten the text into a brief summary',
    asks: 'Does `request` ask to summarize or shorten a text?',
    capability: 'summarization',
    instruction: 'Summarize the text in one short sentence, in the language of the text. Reply with the summary only.',
  },
  {
    id: 'write',
    criterion: 'continue a story or a piece of text',
    asks: 'Does `request` ask to continue or write more of a story or text?',
    capability: 'text-generation',
    instruction: 'Continue the text naturally for two or three sentences. Reply with the continuation only.',
  },
  {
    id: 'reply',
    criterion: 'draft a reply to the message',
    asks: 'Does `request` ask for a reply to a message to be drafted?',
    instruction: 'Draft a short, polite reply to the message. Reply with the draft only.',
  },
  {
    id: 'translate',
    criterion: 'translate the text into another language',
    asks: 'Does `request` ask to translate a text into another language?',
    instruction: 'Translate the text. If no target language is named, translate it into English. Reply with the translation only.',
  },
  {
    id: 'answer',
    criterion: 'answer a question or explain something',
    // A message to process often contains questions for someone else.
    asks: 'Is `request` a question for you to answer, rather than a message to process?',
    instruction: 'Answer the question clearly and briefly.',
  },
];
