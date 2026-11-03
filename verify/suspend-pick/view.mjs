const pickLabel = {
  idle: "router idle",
  human: "human row locked",
  ep: "sender endpoint locked",
  room: "room locked",
  read: "subject status read",
  done: "pick committed",
};
const suspLabel = {
  idle: "operator idle",
  human: "human row updating",
  endpoints: "active endpoints updating",
  scan: "scanning invocations",
  rooms: "cancelling scanned rooms",
  done: "suspension committed",
};
const invLabel = {
  none: "no invocation",
  running: "running invocation",
  refused: "pick refused",
  cancelled: "invocation cancelled",
};

export const title = "Router pick vs suspendHuman";

export const state = (v) => ({
  Router: pickLabel[v.pick] + (v.pickSubject !== "unset" ? `, saw ${v.pickSubject}` : ""),
  Operator: suspLabel[v.susp],
  Room: invLabel[v.inv] + (v.humanStatus === "suspended" ? ", human suspended" : ""),
});

export const step = (a) => ({
  PickLockHuman: "router locks the human row",
  PickLockEp: "router locks the trigger sender's endpoint",
  PickLockRoom: "router locks the room",
  PickReadSubject: "router reads the subject's status",
  PickCommit: "router commits the invocation",
  SuspendUpdateHuman: "operator starts suspending the human",
  SuspendUpdateActiveEps: "operator suspends active endpoints",
  SuspendScan: "operator scans for running invocations",
  SuspendLockRooms: "operator locks scanned rooms",
  SuspendCommit: "operator commits the suspension",
  Done: null,
}[a] ?? null);

export const group = (v) => {
  if (v.humanStatus === "suspended" && v.inv === "running") return "survives";
  if (v.susp === "done") return "suspended";
  if (v.pick === "done") return "picked";
  return "inflight";
};

export const colors = {
  inflight: "blue",
  picked: "teal",
  suspended: "purple",
  survives: "pink",
};
