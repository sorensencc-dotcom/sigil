# Expected /statechart results (MC.cfg and each MC_<mutation>.cfg)

| Config | Rules that must break | Why |
|---|---|---|
| MC.cfg (real code) | AgentRunsOnce only | Known finding: a webhook POST the bot received but the bridge timed out is resent with the same delivery_key. Replayed by the `room-delivery replay` test in floor-warden-bridge.test.mjs. |
| MC_chart.cfg (1 mention, 2 attempts) | AgentRunsOnce only | Small enough for a full chart. |
| MC_dup_delivery.cfg | OneDeliveryPerMention (+ AgentRunsOnce) | A queued mention also gets a delivery row. |
| MC_no_single_shot.cfg | NoDoubleReply (+ AgentRunsOnce) | The reply route accepts a second reply for a completed invocation. |
| MC_no_trigger_check.cfg | ReplyInRightThread, NoDoubleReply (+ AgentRunsOnce) | The reply route drops step 8 (running invocation's trigger must equal in_reply_to). |
| MC_ack_on_retry.cfg | NoLostDelivery (+ AgentRunsOnce) | The daemon acks a room delivery after FLOOR_WARDEN_RETRY instead of leaving it unacked. |
