import { Fragment, useState, type ReactNode } from 'react';
import type { StretchFlag, StretchPart } from './agentStretches';

const NOTICE: Partial<Record<StretchFlag, string>> = {
  cap: 'the agent turn cap was reached',
  halted: 'the room was halted',
  failed: 'a signature check failed',
};

export function CollapsedExchange({
  participants,
  count,
  events,
  expanded,
  onToggle,
  children,
}: {
  participants: string[];
  count: number;
  events: number;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const summary = `${count} agent messages${events > 0 ? ` · ${events} ${events === 1 ? 'event' : 'events'}` : ''}`;
  return (
    <li className="collapsed-exchange" data-expanded={expanded || undefined}>
      <div className="collapsed-exchange-head">
        <strong>Agent exchange</strong>
        <span className="collapsed-exchange-participants">{participants.join(', ')}</span>
        <span className="collapsed-exchange-count">{summary}</span>
        <button type="button" className="ghost" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? 'Collapse' : `Show ${count} messages`}
        </button>
      </div>
      {expanded ? <ul className="collapsed-exchange-rows">{children}</ul> : null}
    </li>
  );
}

// Renders grouped parts. A flagged stretch (cap, halt, failed signature, or a focused row) stays
// unfolded with a note above it, so a fold never hides that state or the cap row's Continue button.
export function FoldedRows<T>({
  parts,
  renderEntry,
  nameOf,
}: {
  parts: StretchPart<T>[];
  renderEntry: (entry: T) => ReactNode;
  nameOf: (entry: T) => string;
}) {
  // Keyed by each stretch's first message id, so a growing stretch keeps its toggle.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  return (
    <>
      {parts.map((part) => {
        if (part.kind === 'single') return renderEntry(part.entry);
        if (part.flags.length > 0) {
          const reasons = part.flags.map((flag) => NOTICE[flag]).filter((reason): reason is string => !!reason);
          return (
            <Fragment key={part.key}>
              {reasons.length > 0 ? <li className="fold-notice" role="note">Agent exchange shown in full: {reasons.join('; ')}</li> : null}
              {part.entries.map(renderEntry)}
            </Fragment>
          );
        }
        return (
          <CollapsedExchange
            key={part.key}
            participants={[...new Set(part.agents.map(nameOf))]}
            count={part.agents.length}
            events={part.events}
            expanded={expanded.has(part.firstId)}
            onToggle={() => toggle(part.firstId)}
          >
            {part.entries.map(renderEntry)}
          </CollapsedExchange>
        );
      })}
    </>
  );
}
