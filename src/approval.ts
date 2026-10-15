import { randomUUID } from "node:crypto";

/**
 * Tool calls held for a yes or no from the human, answered as Allow/Deny cards on
 * the web page. A call runs only on an explicit Allow: a timeout, a Deny, a full
 * queue or a shutdown all refuse it - the gate fails closed.
 *
 * It does not depend on the human channel. The page is always up, and an answer
 * is a click on a card, not a word typed into the chat.
 */

/** A flood of holds is refused rather than queued: each one is a card a person must read. */
const MAX_PENDING = 20;

export type PendingApproval = {
  id: string;
  /** The tool name, as the agent called it. */
  tool: string;
  /** What the call would do, as plain text: a command, a write, a path. */
  summary: string;
  /** Why the call is held at all, so the card can say so. */
  reason: string;
};

export type ApprovalEvent = { type: "approvals"; pending: PendingApproval[] };

type Hold = PendingApproval & {
  resolve: (allow: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class ApprovalGate {
  private holds = new Map<string, Hold>();
  private listeners = new Set<(e: ApprovalEvent) => void>();

  /** Hold one call until the human answers or the window closes. True only on Allow. */
  request(tool: string, summary: string, reason: string, waitMs: number): Promise<boolean> {
    if (this.holds.size >= MAX_PENDING) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => this.settle(id, false), waitMs);
      this.holds.set(id, { id, tool, summary, reason, resolve, timer });
      this.emit();
    });
  }

  /** Answer a held call. False when it is already answered, timed out, or unknown. */
  decide(id: string, allow: boolean): boolean {
    return this.settle(id, allow);
  }

  /** Calls still waiting for an answer, oldest first. */
  pending(): PendingApproval[] {
    return [...this.holds.values()].map(({ id, tool, summary, reason }) => ({ id, tool, summary, reason }));
  }

  subscribe(fn: (e: ApprovalEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Refuse everything still held, so nothing waits on a process that is exiting. */
  close(): void {
    for (const id of [...this.holds.keys()]) this.settle(id, false);
  }

  private settle(id: string, allow: boolean): boolean {
    const hold = this.holds.get(id);
    if (!hold) return false;
    clearTimeout(hold.timer);
    this.holds.delete(id);
    hold.resolve(allow);
    this.emit();
    return true;
  }

  private emit(): void {
    const event: ApprovalEvent = { type: "approvals", pending: this.pending() };
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* a broken page must never break a held call */
      }
    }
  }
}
