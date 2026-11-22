export const title = "Rooms redesign plan: what the reader sees";
const inv = {idle:"No agent working",queued:"Queued",running:"Agent working",held:"Waiting for approval",replied:"Agent replied",failed:"Agent failed",stopped:"Stopped",capped:"Turn cap reached"};
export const state = (v) => ({
  "Agent work": inv[v.inv],
  "Timeline": v.fold === "folded" ? "Exchange folded" : (v.cardShown ? "Approval card shown" : "Exchange open"),
  "Trust mark": {attested:"Relay-attested",relayMatch:"Matches the relay's key",pinMatch:"Matches your pinned key",mismatch:"Pinned key mismatch"}[v.mark],
  "Unread": v.staleNew ? "A read row shows as New" : "New divider correct",
});
const L = {YouSend:"you send a message",AgentStarts:"the agent starts",AgentReplies:"the agent replies",AgentWakesAgent:"the agent wakes another agent",AgentNeedsApproval:"the agent needs approval",OwnerApproves:"the owner approves",AgentFails:"the agent fails",YouStop:"you press Stop",YouFold:"you fold the exchange",YouUnfold:"you unfold it",RowArrives:"a row arrives",OpenRoom:"you open the room",ReadRoom:"you read the new rows",VerifyWithRelayKey:"the browser checks the relay's key",VerifyWithPin:"the browser checks your pinned key"};
export const step = (a) => L[String(a).replace(/\(.*/,"")] ?? null;
