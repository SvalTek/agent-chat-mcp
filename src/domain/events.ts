import { recordLog } from "../infra/logs.ts";
import type { BoardEvent } from "./types.ts";
export class EventHub {
  #listeners = new Set<(event: BoardEvent) => void>();

  subscribe(listener: (event: BoardEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(event: BoardEvent) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        recordLog(
          "error",
          "event-bus",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
}
