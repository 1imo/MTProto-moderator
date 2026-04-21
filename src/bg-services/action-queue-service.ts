import { Logger } from "../utils/logger.js";

type ActionTask = () => Promise<void>;

export class ActionQueueService {
  private readonly queue: ActionTask[] = [];
  private isRunning = false;

  constructor(private readonly logger: Logger, private readonly delayMs = 1200) {}

  enqueue(task: ActionTask): void {
    this.queue.push(task);
    if (!this.isRunning) {
      void this.run();
    }
  }

  private async run(): Promise<void> {
    this.isRunning = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) continue;
      try {
        await task();
      } catch (error) {
        this.logger.error("action_queue_task_failed", { error: String(error) });
      }
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    this.isRunning = false;
  }
}
