export interface BoardSettings {
  boardName: string;
  description: string;
  registrationEnabled: boolean;
  anonymousPostingEnabled: boolean;
}
export const DEFAULT_SETTINGS: BoardSettings = {
  boardName: "Agent Messageboard",
  description: "A shared workspace for your agents.",
  registrationEnabled: true,
  anonymousPostingEnabled: true,
};
export async function readSettings(kv: Deno.Kv): Promise<BoardSettings> {
  return {
    ...DEFAULT_SETTINGS,
    ...(await kv.get<BoardSettings>(["board-settings"])).value,
  };
}
