/**
 * The queue semantics of the human channel, asserted.
 *
 * Nothing else covered this, and it is the part most easily broken by a refactor:
 * what happens when the human speaks while the agent is not listening. These are
 * the behaviours the design depends on - draining everything at once, oldest
 * first, one message verbatim and several merged with a numbered stamp.
 *
 * Usage: node scripts/channel-probe.mjs
 */
import { HumanChannel } from "../src/human/channel.ts";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

const PREFIX = /^\[(\d+)\/(\d+) · (\d{2}):(\d{2}):(\d{2})\] /;

// ---- one message is delivered verbatim -------------------------------------
{
  const c = new HumanChannel();
  c.post("hello");
  const r = await c.wait(undefined, 100);
  check("one queued message arrives verbatim", r.status === "human_message" && r.text === "hello" && r.count === 1,
    JSON.stringify(r));
  check("no prefix on a single message", !PREFIX.test(r.text));
}

// ---- several are merged, oldest first --------------------------------------
{
  const c = new HumanChannel();
  c.post("first");
  await new Promise((r) => setTimeout(r, 1100)); // cross a second boundary so the stamps differ
  c.post("second");
  c.post("third");
  const r = await c.ask("anything?", 100);
  const lines = r.text.split("\n");
  check("three queued messages arrive in one result", r.count === 3 && lines.length === 3, JSON.stringify(r));
  check("merged oldest first", lines[0].endsWith("first") && lines[1].endsWith("second") && lines[2].endsWith("third"),
    r.text.replace(/\n/g, " | "));
  check("each line is numbered n/total", lines.every((l, i) => l.startsWith(`[${i + 1}/3 · `)), lines[0]);
  check("each line carries a clock stamp", lines.every((l) => PREFIX.test(l)), lines[1]);
  check("stamps are non-decreasing", (() => {
    const secs = lines.map((l) => { const m = PREFIX.exec(l); return +m[3] * 3600 + +m[4] * 60 + +m[5]; });
    return secs[0] <= secs[1] && secs[1] <= secs[2];
  })());
  check("count matches the lines", r.count === lines.length);
  check("the result is timestamped with the newest", r.at >= Date.now() - 60000);
}

// ---- a blocked call is woken by a post -------------------------------------
{
  const c = new HumanChannel();
  const p = c.ask("may I?", 5000);
  await new Promise((r) => setTimeout(r, 80));
  check("waiting is reported while blocked", c.waiting() === "ask" && c.deadline() > Date.now());
  c.post("go ahead");
  const r = await p;
  check("a post wakes the blocked call", r.status === "human_message" && r.text === "go ahead" && r.count === 1);
  check("waiting clears after the answer", c.waiting() === null && c.deadline() === null);
}

// ---- the zero-latency tradeoff, stated as a test ---------------------------
{
  const c = new HumanChannel();
  const p = c.ask("may I?", 5000);
  await new Promise((r) => setTimeout(r, 50));
  c.post("one");
  const first = await p;
  c.post("two"); // lands after the wake, so it queues for the next call
  check("the waking message is delivered alone", first.text === "one" && first.count === 1);
  const second = await c.wait(undefined, 100);
  check("a message typed after the wake waits for the next call", second.text === "two", JSON.stringify(second));
}

// ---- junk is dropped --------------------------------------------------------
{
  const c = new HumanChannel();
  c.post("   ");
  c.post("");
  c.post("\n\t");
  c.post("real");
  const r = await c.wait(undefined, 100);
  check("blank posts are dropped", r.text === "real" && r.count === 1, JSON.stringify(r));
  check("blank posts leave no timeline entry", c.history().filter((e) => e.role === "human").length === 1);
}

// ---- the queue has no cap; the timeline does -------------------------------
{
  const c = new HumanChannel();
  for (let i = 0; i < 5000; i++) c.post("m" + i);
  const r = await c.wait(undefined, 100);
  const lines = r.text.split("\n");
  // Deliberately uncapped: dropping a human's messages to protect the context
  // window would be the wrong trade. 5000 queued lines is a self-inflicted wound,
  // and one merged result is still cheaper than 5000 round trips.
  check("a 5000-message queue lands in a single call", r.count === 5000 && lines.length === 5000,
    `count=${r.count} lines=${lines.length}`);
  check("in FIFO order", lines[0].endsWith(" m0") && lines[4999].endsWith(" m4999"),
    `${lines[0].slice(0, 26)} … ${lines[4999].slice(-16)}`);
  const drained = await c.wait(undefined, 200);
  check("and the queue is empty afterwards", drained.status === "no_message", drained.status);
  check("the timeline is capped", c.history().length === 1000, String(c.history().length));
}

// ---- an empty queue really waits -------------------------------------------
{
  const c = new HumanChannel();
  const started = Date.now();
  const r = await c.wait(undefined, 400);
  check("an empty queue blocks and returns no_message",
    r.status === "no_message" && Date.now() - started >= 380, `${r.status} after ${Date.now() - started}ms`);
  check("no_message tells the model to call again", /call .* again/i.test(r.hint), r.hint.slice(0, 40));
}

// ---- the whole queue lands in one call, which is the point -----------------
{
  const c = new HumanChannel();
  c.post("run the tests");
  c.post("actually don't, they are flaky");
  const r = await c.wait(undefined, 100);
  check("a retraction arrives with what it retracts",
    r.count === 2 && r.text.includes("run the tests") && r.text.includes("actually don't"),
    r.text.replace(/\n/g, " | "));
  check("and the retraction is the last line", r.text.split("\n").pop().endsWith("they are flaky"));
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall channel checks passed");
process.exit(failures ? 1 : 0);
