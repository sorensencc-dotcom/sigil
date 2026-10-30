import { emitRoomEvent } from './sigil/relay/v1/room-events.mjs';

async function mockEmitRoomEvent() {
    return new Promise(resolve => setTimeout(resolve, 5));
}

async function sequential(rows) {
    const start = performance.now();
    for (const invocation of rows) {
        await mockEmitRoomEvent();
    }
    const end = performance.now();
    return end - start;
}

async function concurrent(rows) {
    const start = performance.now();
    await Promise.all(rows.map(invocation => mockEmitRoomEvent()));
    const end = performance.now();
    return end - start;
}

async function run() {
    const rows = Array.from({length: 100}).map((_, i) => ({
        invocation_id: `inv_${i}`,
        endpoint_id: `ep_${i}`
    }));

    const seqTime = await sequential(rows);
    const concTime = await concurrent(rows);

    console.log(`Sequential time: ${seqTime.toFixed(2)}ms`);
    console.log(`Concurrent time: ${concTime.toFixed(2)}ms`);
}

run();
