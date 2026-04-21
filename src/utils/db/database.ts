import fs from "node:fs";
import path from "node:path";
import type { ModerationDecision } from "../../types.js";
import type { Env } from "../env.js";

type DbShape = {
  messages: Array<{
    senderId: string;
    chatId: string;
    createdAt: string;
  }>;
  actionLogs: Array<{
    senderId: string;
    chatId: string;
    decision: ModerationDecision;
    createdAt: string;
  }>;
  sessions: Array<{
    userId: string;
    sessionString: string;
    active: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
  analyticsEvents: Array<{
    event: string;
    props: Record<string, unknown>;
    createdAt: string;
  }>;
  users: Array<{
    telegramId: number;
    username: string;
    firstName: string;
    lastName: string;
    lastSeenAt: string;
  }>;
  groupChats: Array<{
    telegramId: number;
    firstSeenAt: string;
    lastSeenAt: string;
  }>;
};

const emptyState = (): DbShape => ({
  messages: [],
  actionLogs: [],
  sessions: [],
  analyticsEvents: [],
  users: [],
  groupChats: []
});

export type PersistInvalidateHook = () => void;

export class Database {
  private readonly filePath: string;
  private state: DbShape;

  constructor(
    env: Env,
    private readonly onAfterPersist?: PersistInvalidateHook
  ) {
    if (!env.DATABASE_PATH.trim()) {
      throw new Error("DATABASE_PATH is empty");
    }

    const resolved = path.resolve(env.DATABASE_PATH);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.filePath = resolved;

    if (!fs.existsSync(this.filePath)) {
      this.state = emptyState();
      this.persist();
    } else {
      const loaded = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<DbShape>;
      this.state = {
        messages: loaded.messages ?? [],
        actionLogs: loaded.actionLogs ?? [],
        sessions: loaded.sessions ?? [],
        analyticsEvents: loaded.analyticsEvents ?? [],
        users: loaded.users ?? [],
        groupChats: loaded.groupChats ?? []
      };
      this.persist();
    }
  }

  get messages(): DbShape["messages"] {
    return this.state.messages;
  }

  get actionLogs(): DbShape["actionLogs"] {
    return this.state.actionLogs;
  }

  get sessions(): DbShape["sessions"] {
    return this.state.sessions;
  }

  get analyticsEvents(): DbShape["analyticsEvents"] {
    return this.state.analyticsEvents;
  }

  get users(): DbShape["users"] {
    return this.state.users;
  }

  get groupChats(): DbShape["groupChats"] {
    return this.state.groupChats;
  }

  persist(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
    this.onAfterPersist?.();
  }
}
