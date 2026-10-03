/**
 * A single in-memory human channel. No sessions, no persistence: this process
 * is meant to live for exactly one sitting.
 *
 * The timeline carries three roles: `agent` and `human` are conversation, `tool`
 * is the record of what the agent did on this machine between messages. They
 * share one ordered list so the UI can show doing and saying in the order they
 * actually happened.
 */

/** Enough for a long sitting; a tool-heavy session fills this faster than chat does. */
const MAX_ENTRIES = 1000;

export type Entry = {
  id: string;
  role: "agent" | "human" | "tool";
  kind: string;
  text: string;
  at: number;
  /** Present on `tool` entries only. */
  tool?: string;
  status?: "running" | "ok" | "error";
  ms?: number;
  detail?: string;
};

export type WaitResult =
  | { status: "human_message"; text: string; at: number }
  | { status: "no_message"; waited_ms: number; hint: string };

export type ChannelEvent =
  | { type: "entry"; entry: Entry }
  | { type: "entry_update"; id: string; patch: Partial<Entry> }
  | { type: "state"; waiting: "ask" | "wait" | null; deadline: number | null };

/**
 * Fallback text only. The MCP layer replaces this with a tool-specific sentence that names
 * the tool to call again (see humanResult in server.ts), so the two cannot drift apart.
 */
const NO_MESSAGE_HINT =
  "Nothing arrived before the wait window closed. This is not a failure and not a reason to " +
  "stop: call it again immediately, and keep calling it. Do not end your turn while waiting " +
  "for the human.";

export class HumanChannel {
  private entries: Entry[] = [];
  private subs = new Set<(e: ChannelEvent) => void>();
  private inbox: { text: string; at: number }[] = [];
  private pending: {
    kind: "ask" | "wait";
    /** Epoch ms at which the window closes. The UI counts down from this. */
    deadline: number;
    resolve: (r: WaitResult) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private seq = 0;
  private readonly startedAt = Date.now();

  subscribe(fn: (e: ChannelEvent) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private emit(e: ChannelEvent): void {
    for (const fn of this.subs) {
      try {
        fn(e);
      } catch {
        /* a broken UI must never break the agent loop */
      }
    }
  }

  private state(): ChannelEvent {
    return { type: "state", waiting: this.waiting(), deadline: this.deadline() };
  }

  private push(role: Entry["role"], kind: string, text: string, extra: Partial<Entry> = {}): Entry {
    const entry: Entry = { id: `e${++this.seq}`, role, kind, text, at: Date.now(), ...extra };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.emit({ type: "entry", entry });
    return entry;
  }

  history(): Entry[] {
    return this.entries.slice();
  }

  waiting(): "ask" | "wait" | null {
    return this.pending?.kind ?? null;
  }

  /** Epoch ms when the current wait window closes, or null when nothing is waiting. */
  deadline(): number | null {
    return this.pending?.deadline ?? null;
  }

  /** Everything the info panel needs that is not static configuration. */
  snapshot(): { waiting: "ask" | "wait" | null; deadline: number | null; entries: number; startedAt: number } {
    return {
      waiting: this.waiting(),
      deadline: this.deadline(),
      entries: this.entries.length,
      startedAt: this.startedAt,
    };
  }

  /** Agent -> human, fire and forget. */
  say(text: string, kind = "message"): void {
    this.push("agent", kind, text);
  }

  /** Agent -> human, blocks until the human answers. */
  ask(text: string, blockMs: number): Promise<WaitResult> {
    this.push("agent", "question", text);
    return this.await(blockMs, "ask");
  }

  /** Blocks until the human says anything. */
  async wait(reason: string | undefined, blockMs: number): Promise<WaitResult> {
    if (reason) this.push("agent", "waiting", reason);
    return this.await(blockMs, "wait");
  }

  private await(blockMs: number, kind: "ask" | "wait"): Promise<WaitResult> {
    const queued = this.inbox.shift();
    if (queued) {
      return Promise.resolve({ status: "human_message", text: queued.text, at: queued.at });
    }
    if (this.pending) {
      return Promise.resolve({
        status: "no_message",
        waited_ms: 0,
        hint: "Another human_ask/human_wait is already in flight from this same server. Wait for it to return instead of issuing a second one.",
      });
    }
    const started = Date.now();
    return new Promise<WaitResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending = null;
        this.emit(this.state());
        resolve({ status: "no_message", waited_ms: Date.now() - started, hint: NO_MESSAGE_HINT });
      }, blockMs);
      this.pending = { kind, deadline: started + blockMs, resolve, timer };
      this.emit(this.state());
    });
  }

  /** Human -> agent. Called by the local UI. */
  post(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const entry = this.push("human", "message", trimmed);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      const { resolve } = this.pending;
      this.pending = null;
      this.emit(this.state());
      resolve({ status: "human_message", text: trimmed, at: entry.at });
    } else {
      this.inbox.push({ text: trimmed, at: entry.at });
    }
  }

  /**
   * Agent -> timeline: a tool call started. Returns the entry id so the caller can
   * close it with toolEnd. Deliberately never throws: recording what happened must
   * not be able to break the call itself.
   */
  toolStart(tool: string, text: string): string {
    return this.push("tool", "tool", text, { tool, status: "running" }).id;
  }

  /** Close a tool entry with its outcome. A no-op if the entry was evicted. */
  toolEnd(id: string, ok: boolean, ms: number, detail?: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    const patch: Partial<Entry> = { status: ok ? "ok" : "error", ms };
    if (detail) patch.detail = detail;
    Object.assign(entry, patch);
    this.emit({ type: "entry_update", id, patch });
  }

  /** Release any blocked call so the process can exit. */
  shutdown(): void {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.resolve({ status: "no_message", waited_ms: 0, hint: "Server is shutting down." });
      this.pending = null;
    }
  }
}
