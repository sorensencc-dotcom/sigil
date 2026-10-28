import { describe, expect, it } from 'vitest';
import { extractMentionTokens, resolveMentions } from './resolveMentions';

const members = [
  { endpoint_id: 'ep_chief', display_name: 'Chief' },
  { endpoint_id: 'ep_claude', display_name: 'Claude' },
  { endpoint_id: 'ep_twin_a', display_name: 'Twin' },
  { endpoint_id: 'ep_twin_b', display_name: 'Twin' },
  { endpoint_id: 'ep_web', display_name: '' },
];

describe('extractMentionTokens', () => {
  it('extracts tokens using the bridge ID_CONTINUES charset', () => {
    expect(extractMentionTokens('hey @ep_chief and @ep_claude.x please')).toEqual(['ep_chief', 'ep_claude.x']);
  });

  it('keeps duplicates in extraction order', () => {
    expect(extractMentionTokens('@ep_chief hi @ep_chief')).toEqual(['ep_chief', 'ep_chief']);
  });

  it('returns an empty list when there are no @tokens', () => {
    expect(extractMentionTokens('plain text')).toEqual([]);
  });
});

describe('resolveMentions', () => {
  it('resolves exact endpoint_id matches', () => {
    expect(resolveMentions('@ep_chief ping', members)).toEqual(['ep_chief']);
  });

  it('resolves a unique case-insensitive display_name', () => {
    expect(resolveMentions('hey @chief', members)).toEqual(['ep_chief']);
    expect(resolveMentions('hey @CHIEF', members)).toEqual(['ep_chief']);
  });

  it('prefers exact endpoint_id over display_name', () => {
    const clash = [
      { endpoint_id: 'chief', display_name: 'Other' },
      { endpoint_id: 'ep_other', display_name: 'chief' },
    ];
    expect(resolveMentions('@chief', clash)).toEqual(['chief']);
  });

  it('skips ambiguous display_name matches', () => {
    expect(resolveMentions('@twin hello', members)).toEqual([]);
  });

  it('skips unresolved tokens without inventing ids', () => {
    expect(resolveMentions('@nobody @ep_chief', members)).toEqual(['ep_chief']);
  });

  it('dedupes while preserving first-seen order', () => {
    expect(resolveMentions('@ep_claude then @Chief then @ep_claude', members)).toEqual(['ep_claude', 'ep_chief']);
  });

  it('does not match empty display names', () => {
    expect(resolveMentions('@', members)).toEqual([]);
  });
});
