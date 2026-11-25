// Loaded by `npm test` through `node --import`. Test files run as child processes and inherit
// this, so the per-hop `sigil.hop` log lines (thousands per run) stay out of test output.
// A test that needs hop lines sets SIGIL_HOP_LOG itself; process.env.SIGIL_HOP_LOG set by the
// caller wins, so `SIGIL_HOP_LOG=1 npm test` brings them back.
process.env.SIGIL_HOP_LOG ??= '0';
