export function renderApprovalPage({ challenge, error = null } = {}) {
  const isInvalid = !challenge || challenge.used || (challenge.expiresAt && Date.parse(challenge.expiresAt) <= Date.now());
  const statusMessage = error ? `<div class="alert error">${escapeHtml(error)}</div>` : '';

  if (isInvalid) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sigil Approval Expired</title>
  <style>${baseCss()}</style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="badge error">Expired</div>
      <h1>Approval Request Unavailable</h1>
    </div>
    <p>This approval challenge has already been consumed or has expired.</p>
    <p class="hint">Return to your agent host and initiate a new request.</p>
  </div>
</body>
</html>`;
  }

  const safeActionHash = escapeHtml(challenge.actionHash ?? 'unknown');
  const safeEndpointId = escapeHtml(challenge.endpointId ?? 'unknown');
  const safeChallengeId = escapeHtml(challenge.id);
  const safeExpiresAt = escapeHtml(challenge.expiresAt ?? '');
  const callbackUrlJson = JSON.stringify(challenge.callbackUrl ?? '');
  const challengeIdJson = JSON.stringify(challenge.id);
  const webauthnChallengeJson = JSON.stringify(challenge.webauthnChallenge ?? '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sigil Action Authorization</title>
  <style>${baseCss()}</style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="badge warn">High-Risk Operation</div>
      <h1>Authorization Required</h1>
      <p class="subtitle">An agent is requesting verified human approval for a high-risk capability.</p>
    </div>

    ${statusMessage}

    <div class="details">
      <div class="detail-row">
        <span class="label">Target Endpoint</span>
        <code class="val">${safeEndpointId}</code>
      </div>
      <div class="detail-row">
        <span class="label">Action Hash</span>
        <code class="val hash">${safeActionHash}</code>
      </div>
      <div class="detail-row">
        <span class="label">Challenge ID</span>
        <code class="val">${safeChallengeId}</code>
      </div>
      <div class="detail-row">
        <span class="label">Expires At</span>
        <span class="val">${safeExpiresAt}</span>
      </div>
    </div>

    <div id="action-area">
      <button id="approve-btn" class="btn primary">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        Approve with Passkey (Touch ID / Security Key)
      </button>
      <div id="status-text" class="status-indicator"></div>
    </div>
  </div>

  <script>
    const challengeId = ${challengeIdJson};
    const callbackUrl = ${callbackUrlJson};
    const rawWebauthnChallenge = ${webauthnChallengeJson};

    function bufferFromBase64Url(base64url) {
      const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(base64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      return buf.buffer;
    }

    function base64UrlFromBuffer(buffer) {
      const bytes = new Uint8Array(buffer);
      let bin = '';
      for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
    }

    const btn = document.getElementById('approve-btn');
    const statusText = document.getElementById('status-text');

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      statusText.innerText = 'Prompting for biometric / hardware passkey...';
      statusText.className = 'status-indicator info';

      try {
        if (!navigator.credentials || !navigator.credentials.get) {
          throw new Error('WebAuthn is not supported in this browser environment.');
        }

        const credential = await navigator.credentials.get({
          publicKey: {
            challenge: bufferFromBase64Url(rawWebauthnChallenge),
            userVerification: 'required',
            timeout: 60000
          }
        });

        if (!credential) throw new Error('Passkey ceremony cancelled or aborted.');

        statusText.innerText = 'Verifying passkey assertion on relay...';

        const payload = {
          credential_id: credential.id,
          client_data_json: base64UrlFromBuffer(credential.response.clientDataJSON),
          authenticator_data: base64UrlFromBuffer(credential.response.authenticatorData),
          signature: base64UrlFromBuffer(credential.response.signature)
        };

        const res = await fetch('/v1/approval-challenges/' + encodeURIComponent(challengeId) + '/assertion', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Verification failed on relay');

        statusText.innerText = 'Approved! Relaying decision token to connector...';
        statusText.className = 'status-indicator success';

        if (callbackUrl) {
          const sep = callbackUrl.includes('?') ? '&' : '?';
          window.location.href = callbackUrl + sep + 'token=' + encodeURIComponent(data.token || challengeId);
        } else {
          statusText.innerText = 'Approval Verified. You may close this tab.';
        }
      } catch (err) {
        btn.disabled = false;
        statusText.innerText = 'Error: ' + err.message;
        statusText.className = 'status-indicator error';
      }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function baseCss() {
  return `
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --heading: #f0f6fc;
      --primary: #238636;
      --primary-hover: #2ea043;
      --warn-bg: rgba(210, 153, 34, 0.15);
      --warn-border: #d29922;
      --error-bg: rgba(248, 81, 73, 0.15);
      --error-border: #f85149;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 20px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      max-width: 580px;
      width: 100%;
      padding: 28px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    }
    .header { margin-bottom: 20px; }
    .badge {
      display: inline-block;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 3px 8px;
      border-radius: 12px;
      margin-bottom: 12px;
    }
    .badge.warn { background: var(--warn-bg); color: var(--warn-border); border: 1px solid var(--warn-border); }
    .badge.error { background: var(--error-bg); color: var(--error-border); border: 1px solid var(--error-border); }
    h1 { color: var(--heading); font-size: 20px; margin-bottom: 6px; }
    .subtitle { font-size: 13px; color: #8b949e; line-height: 1.4; }
    .details {
      background: #0d1117;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 14px;
      margin-bottom: 24px;
      font-size: 13px;
    }
    .detail-row { display: flex; flex-direction: column; margin-bottom: 10px; }
    .detail-row:last-child { margin-bottom: 0; }
    .label { font-size: 11px; color: #8b949e; text-transform: uppercase; margin-bottom: 2px; }
    .val { color: var(--heading); word-break: break-all; }
    code.val { font-family: monospace; font-size: 12px; background: rgba(110,118,129,0.1); padding: 2px 4px; border-radius: 4px; }
    code.hash { color: #58a6ff; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 100%;
      padding: 12px 18px;
      font-size: 14px;
      font-weight: 600;
      border-radius: 6px;
      cursor: pointer;
      border: 1px solid transparent;
      transition: background 0.15s ease;
    }
    .btn.primary {
      background: var(--primary);
      color: #fff;
    }
    .btn.primary:hover:not(:disabled) {
      background: var(--primary-hover);
    }
    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .status-indicator {
      margin-top: 14px;
      font-size: 13px;
      text-align: center;
      min-height: 20px;
    }
    .status-indicator.info { color: #58a6ff; }
    .status-indicator.success { color: #3fb950; font-weight: 600; }
    .status-indicator.error { color: #f85149; }
    .alert.error {
      background: var(--error-bg);
      border: 1px solid var(--error-border);
      color: var(--error-border);
      padding: 10px;
      border-radius: 6px;
      margin-bottom: 16px;
      font-size: 13px;
    }
  `;
}
