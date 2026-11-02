// System 1: one fast forward pass over typed questions, returning calibrated
// probabilities and never generated text. The shapes match @wexare/laya-web
// (and the Python `laya` library), so a loaded LayaWorkerClient is a System1.

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** option -> short description */
  criteria: Record<string, string>;
}

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
}

export type Question = ChoiceQuestion | NoulQuestion;

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  /** 1 - normalized entropy of the distribution */
  confidence: number;
  action?: { act_probability: number | null };
}

export interface NoulAnswer {
  type: 'noul';
  /** P(true) */
  noul: number;
  confidence: number;
  action?: { act_probability: number | null };
}

export interface System1Result {
  answers: Record<string, ChoiceAnswer | NoulAnswer>;
  latency_ms: number;
  device?: string;
}

export interface System1 {
  predict(state: unknown, questions: Record<string, Question>): Promise<System1Result>;
}
