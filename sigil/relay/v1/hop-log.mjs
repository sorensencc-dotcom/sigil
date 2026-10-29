// One greppable line per latency hop: `sigil.hop {"t":"<iso>","hop":"...",...ids}`.
// Callers pass ids only (invocation, delivery, message, room), never payloads or
// credentials. SIGIL_HOP_LOG=0 turns the lines off.
export function logHop(hop, fields = {}, logger = console) {
  if (process.env.SIGIL_HOP_LOG === '0') return;
  logger.info?.(`sigil.hop ${JSON.stringify({ t: new Date().toISOString(), hop, ...fields })}`);
}
