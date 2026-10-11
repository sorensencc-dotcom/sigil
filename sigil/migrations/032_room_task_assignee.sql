-- Room task.request names its assignee in the body. The invocation row records
-- that decision separately from a mention or a router pick.

ALTER TABLE room_invocations DROP CONSTRAINT IF EXISTS room_invocations_decided_by_check;
ALTER TABLE room_invocations ADD CONSTRAINT room_invocations_decided_by_check
  CHECK (decided_by IN ('mention', 'router', 'assignee'));
