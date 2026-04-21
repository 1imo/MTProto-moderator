export type UserConfig = {
  userId: string;
  prompt: string;
};

export class UserRepository {
  getById(userId: string): UserConfig | null {
    return { userId, prompt: "" };
  }
}
