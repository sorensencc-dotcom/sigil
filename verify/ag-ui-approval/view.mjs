export const title = "Sigil AG-UI run with a gated envelope";

const appr = { none: "", pending: "approval waiting", approved: "approved", expired: "approval expired", consumed: "approval used" };

export const state = (v) => {
  const done = v.toolRuns > 0;
  switch (v.phase) {
    case "idle": return "No run yet";
    case "interrupted": return `Paused for approval (${appr[v.decision]})`;
    case "streaming":
      if (done) return v.resultShown ? "Streaming, action done and shown" : "Streaming, action done, not shown";
      return v.decision === "approved" ? "Streaming, waiting for worker" : v.decision === "expired" ? "Streaming, approval expired" : "Streaming";
    case "done": return done ? "Finished, action done" : "Finished, no gated action";
    case "error": return done ? "Error shown, but action done" : "Error shown";
    case "truncated": return done ? "Stream cut, action done" : "Stream cut";
    default: return v.phase;
  }
};

export const group = (v) =>
  v.phase === "interrupted" ? "waiting" : v.phase === "done" ? "ok" : v.phase === "error" || v.phase === "truncated" ? "bad" : "active";

export const colors = { waiting: "orange", ok: "teal", bad: "pink", active: "blue" };

export const step = (action, from, to) => {
  switch (action) {
    case "ClientStartsRun": return "client starts a run";
    case "WorkerRequestsApproval": return "worker asks for approval";
    case "HumanApproves": return "you approve with your key";
    case "ApprovalExpires": return "approval times out";
    case "WorkerSubmitsEnvelope": return "worker sends the gated envelope";
    case "WorkerRetriesEnvelope": return "worker resends the same envelope";
    case "ClientResumesTooEarly": return null;
    case "ClientCancels": return "client cancels the approval";
    case "ClientResumes":
      if (to.phase === "error") return "client resumes [no usable approval]";
      return to.resultShown ? "client resumes [action already done]" : "client resumes [approved]";
    case "WaitExpires": return "approval times out";
    case "AgentFinishes": return "agent finishes";
    case "StreamDrops": return "connection drops";
    case "ClientRetriesAfterDrop": return to.phase === "error" ? "client retries the resume [fails]" : "client retries the resume";
    case "Idle": return null;
    default: return action;
  }
};
