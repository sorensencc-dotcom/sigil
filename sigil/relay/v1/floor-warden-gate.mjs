const answer = (response, requestId, status, code, message) => {
  response.writeHead(status, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
  return response.end(JSON.stringify({ request_id: requestId, code, message, details: {} }));
};

export function createFloorWardenGate({ match, handler, authenticateRequest, distinguishEndpointPrincipal = true, logger, configured = true } = {}) {
  return async function gate({ request, response, requestId, roomId, now, readBody, matched: preMatched = null }) {
    const bearerHeader = request.headers.authorization;
    const bearer = typeof bearerHeader === 'string' && bearerHeader.startsWith('Bearer ') ? bearerHeader.slice(7) : '';
    if (!configured) return answer(response, requestId, 404, 'NOT_FOUND', 'Not found');
    const matched = preMatched ?? (typeof match === 'function' ? await match(bearer) : null);
    if (!matched) {
      const endpointPrincipal = distinguishEndpointPrincipal && bearer && authenticateRequest ? await authenticateRequest(request) : null;
      if (endpointPrincipal) return answer(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'This route accepts only the Floor Warden reply token');
      return answer(response, requestId, 401, 'UNAUTHENTICATED', 'Authentication required');
    }
    if (typeof handler !== 'function') return answer(response, requestId, 503, 'FLOOR_WARDEN_UNAVAILABLE', 'Floor Warden replies are not available');
    let decodedRoomId;
    try { decodedRoomId = decodeURIComponent(roomId); } catch { return answer(response, requestId, 400, 'INVALID_REQUEST', 'Malformed room ID in path'); }
    try {
      const result = await handler({ request, response, requestId, roomId: decodedRoomId, now, readBody, botId: matched.botId ?? null, tokenId: matched.tokenId ?? null });
      if (result?.handled) return;
      response.writeHead(result?.status ?? 500, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
      return response.end(JSON.stringify({ request_id: requestId, ...(result?.body ?? {}) }));
    } catch (error) {
      logger?.error?.({ event: 'floor_warden_reply_failed', request_id: requestId, code: error?.code ?? null });
      if (response.headersSent) return response.end();
      return answer(response, requestId, 503, 'DATABASE_UNAVAILABLE', 'Rooms temporarily unavailable');
    }
  };
}
