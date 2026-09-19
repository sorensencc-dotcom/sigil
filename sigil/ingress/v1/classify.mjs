const CLASSIFICATIONS = Object.freeze(['public', 'internal', 'confidential', 'financial_sensitive']);
const FINANCIAL_MARKERS = /\b(?:financial|account\s+number|routing\s+number|bank\s+account|credit\s+card|ssn|tax\s+id|portfolio|invoice|payroll|wire\s+transfer)\b|[$€£]\s?\d/i;
const PROMPT_INJECTION_MARKERS = /ignore\s+(?:all|any|the|previous|prior)\s+instructions|reveal\s+(?:credentials|secrets|system\s+prompt)|bypass\s+(?:policy|approval|security)/i;

function policyFor(classification) {
  return {
    authorized: false,
    localOnly: classification === 'financial_sensitive',
    cloudAllowed: classification !== 'financial_sensitive',
    externalWebhookAllowed: classification !== 'financial_sensitive',
    retention: classification === 'financial_sensitive' ? 'short' : 'standard',
  };
}

export function classifyInboundMessage({ sender = {}, workflow = '', body = '', attachments = [] } = {}) {
  const reasons = [];
  const text = typeof body === 'string' ? body : '';
  const attachmentText = (attachments ?? []).map((attachment) => `${attachment?.classification ?? ''} ${attachment?.filename ?? ''} ${attachment?.mediaType ?? ''}`).join(' ');
  const combined = `${text} ${attachmentText}`;
  let classification = 'public';
  if (FINANCIAL_MARKERS.test(combined) || attachments.some((attachment) => attachment?.classification === 'financial_sensitive')) {
    classification = 'financial_sensitive';
    reasons.push('financial_marker_detected');
  } else if (sender.internal === true) {
    classification = 'internal';
    reasons.push('verified_internal_sender');
  } else if (sender.confidential === true || workflow === 'review' || workflow === 'approval') {
    classification = 'confidential';
    reasons.push('confidential_workflow_or_sender');
  }
  if (PROMPT_INJECTION_MARKERS.test(combined)) reasons.push('prompt_injection_warning');
  if (reasons.length === 0) reasons.push('no_sensitive_markers');
  return { classification, reasons, policy: policyFor(classification) };
}

export { CLASSIFICATIONS };
