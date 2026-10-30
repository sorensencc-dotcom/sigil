// Chart labels for RoomDelivery: what the room owner sees for @mention m1.
export const title = "Sigil room: one @mention to the bot, from post to reply";
export const state = (v) => {
  const s = v.inv.m1;
  if (s === "none") return "Not posted";
  if (s === "queued") return "Waiting behind another mention";
  if (s === "completed") return "Bot replied in thread";
  if (s === "failed") return "Gave up (bot unreachable, rejected or timed out)";
  if (!v.up) return "Running, bridge down";
  if (v.busy === "m1") return v.phase === "ok" ? "Bot has it, bridge not yet recorded" : "Bridge calling the bot";
  if (v.forwards.m1) return "Bot working, waiting for reply";
  return "Running, waiting for the bridge";
};
export const group = (v) => ({ none: "start", queued: "wait", running: "work", completed: "done", failed: "fail" })[v.inv.m1];
export const colors = { start: "tan", wait: "yellow", work: "blue", done: "teal", fail: "orange" };
const L = {
  HumanPostsMention: "you post the @mention", BridgePicks: "the bridge picks up the delivery",
  PostOk: "the bot's webhook answers OK", RecordForward: "the bridge records the forward",
  PostRetry: "the webhook call times out or errors", PostReject: "the webhook rejects the call",
  AgentReplies: "the bot posts its reply", AgentGivesUp: null, ReplyTimeout: "no reply before the deadline",
  BridgeCrash: "the bridge restarts", BridgeRestart: "the bridge comes back", Done: null,
};
export const step = (a) => (a in L ? L[a] : a);
