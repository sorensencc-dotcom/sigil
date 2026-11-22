export const title = "Rooms client: what the screen shows while an agent works";
export const state = (v) => {
  if (v.ui === "nothingToStop" && ["failed","stopped","capped"].includes(v.inv)) return (v.inv === "failed" ? "Failed" : v.inv === "stopped" ? "Stopped" : "Capped") + ", Stop note replaced the message";
  const ui = v.ui;
  switch (v.inv) {
    case "idle": return v.lastStop ? "Idle, Stop pressed, screen unchanged" : "Idle";
    case "queued": return "Mention sent, agent not started";
    case "running": return ui === "working" ? "Agent running, working cue shown" : "Agent running, screen shows nothing";
    case "failed": return ui === "failureSentence" ? "Failed, plain sentence" : "Failed, raw code line" + (v.lastStop ? ", Stop pressed" : "");
    case "replied": return v.lastStop ? "Replied, Stop pressed, screen unchanged" : "Replied";
    case "stopped": return ui === "stopNote" ? "Stopped, result shown" : "Stopped, raw event line";
    case "capped": return ui === "capBanner" ? "Capped, Continue offered" : "Capped, raw event line";
  }
};
export const step = (a, f, t) => ({
  YouMention: "you mention the agent",
  AgentStarts: "the agent starts",
  AgentFails: "the agent fails to start",
  AgentReplies: "the agent replies",
  AgentHitsCap: "the agent uses its last turn",
  StopActive: "you press Stop [work is running]",
  StopIdle: "you press Stop [nothing is running]",
  YouContinue: "you press Continue",
}[a] ?? a);

