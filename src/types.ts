export type ModerationAction = "allow" | "ignore" | "block";

export interface ModerationDecision {
  action: ModerationAction;
  confidence: number;
  reason: string;
}

export interface IncomingMessage {
  sessionId: string;
  chatId: string;
  senderId: string;
  text: string;
  date: Date;
}

export type SessionRecord = {
  userId: string;
  sessionString: string;
  active: boolean;
};
