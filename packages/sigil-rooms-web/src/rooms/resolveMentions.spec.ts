import { describe, expect, it } from 'vitest';
import { extractMentionTokens, normalizeMentions, resolveMentions, roomMemberName } from './resolveMentions';

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

  it('resolves viewer contact names and rewrites message text to endpoint IDs', () => {
    const nameFor = (id: string, fallback?: string) => id === 'ep_chief' ? 'Chief Contact' : fallback || id;
    expect(normalizeMentions('hey @Chief Contact please', members, nameFor)).toEqual({
      text: 'hey @ep_chief please',
      mentions: ['ep_chief'],
    });
  });

  it('disambiguates same-name members with their login', () => {
    const twins = [
      { endpoint_id: 'ep_twin_a', display_name: 'Twin' },
      { endpoint_id: 'ep_twin_b', display_name: 'Twin' },
    ];
    const nameFor = (id: string) => id === 'ep_twin_a' ? 'Twin' : 'Twin';
    const loginFor = (id: string) => id === 'ep_twin_a' ? 'alice' : 'bob';
    expect(normalizeMentions('@Twin (bob)', twins, nameFor, loginFor)).toEqual({
      text: '@ep_twin_b',
      mentions: ['ep_twin_b'],
    });
    expect(resolveMentions('@Twin', twins, nameFor, loginFor)).toEqual([]);
  });
});

describe('roomMemberName collisions', () => {
  it("shows 'Name (login)' when two members resolve to the same name, and sends ids", () => {
    const members = [
      { endpoint_id: 'ep_rich_a', display_name: 'Rich' },
      { endpoint_id: 'ep_rich_b', display_name: 'Rich' },
      { endpoint_id: 'ep_solo', display_name: 'Solo' },
    ];
    expect(roomMemberName(members[0]!, members)).toBe('Rich (ep_rich_a)');
    expect(roomMemberName(members[1]!, members)).toBe('Rich (ep_rich_b)');
    expect(roomMemberName(members[2]!, members)).toBe('Solo');
    expect(normalizeMentions('hi @Rich (ep_rich_b) and @Solo', members)).toEqual({ text: 'hi @ep_rich_b and @ep_solo', mentions: ['ep_rich_b', 'ep_solo'] });
    expect(resolveMentions('@Rich', members)).toEqual([]);
  });
});
