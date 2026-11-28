import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The Playwright suite (e2e/*.e2e.ts) only runs in CI, so a UI change can land and break it after the
// fact. Almost every past break was the same mistake: a locator that matched by loose text or a loose
// accessible name, and a later UI change (a pin button, a reply preview, a sidebar message preview)
// added a second match or renamed the first. These rules run in vitest, which the pre-push web gate
// already runs, so the mistake is caught before the push instead of on main.

export interface LocatorProblem { line: number; rule: string; text: string }

const ABSENCE = /\.toHaveCount\(0\)/;

export function locatorProblems(source: string): LocatorProblem[] {
  const problems: LocatorProblem[] = [];
  source.split('\n').forEach((text, index) => {
    const line = index + 1;
    if (ABSENCE.test(text)) return; // a broad match makes "nothing like this is shown" stricter, not looser
    for (const call of text.matchAll(/page\.getByText\(([^)]*)\)/g)) {
      if (!/exact:\s*true/.test(call[1] ?? '')) {
        problems.push({ line, rule: 'page.getByText needs { exact: true }, or scope it to the timeline or thread', text: text.trim() });
      }
    }
    for (const call of text.matchAll(/getByRole\('button',\s*\{([^}]*)\}\)/g)) {
      const options = call[1] ?? '';
      if (/name:\s*['"`/]/.test(options) && !/exact:\s*true/.test(options)) {
        problems.push({ line, rule: 'a button found by name needs exact: true', text: text.trim() });
      }
    }
  });
  return problems;
}

describe('e2e locator rules', () => {
  it('catches the locators that broke main before', () => {
    // Each line is a locator from an earlier e2e failure on main.
    const pastBreaks = [
      "await page.getByRole('button', { name: 'e2e-room' }).click();", // dc76147: Pin e2e-room also matched
      "await expect(page.getByText(pushed)).toBeVisible({ timeout: 10_000 });", // 813d0ee: sidebar preview repeated it
      "await expect(page.getByText('hello from the browser')).toBeVisible();", // same preview, a race on refresh
      "await expect(page.getByRole('button', { name: /^build/ })).toBeVisible();",
    ];
    for (const line of pastBreaks) expect(locatorProblems(line), line).toHaveLength(1);
  });

  it('allows scoped text, exact names, and broad absence checks', () => {
    const fine = [
      "await expect(timeline(page).getByText(pushed, { exact: true })).toBeVisible();",
      "await expect(page.getByText('Live', { exact: true })).toBeVisible();",
      "await page.getByRole('button', { name: 'Send', exact: true }).click();",
      "await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);",
      "const roomButton = (page: Page, name: string) => page.getByRole('button', { name, exact: true });",
    ];
    for (const line of fine) expect(locatorProblems(line), line).toEqual([]);
  });

  it('holds for every e2e file', () => {
    const dir = path.resolve(import.meta.dirname, '../e2e');
    const files = readdirSync(dir).filter((file) => file.endsWith('.e2e.ts'));
    expect(files.length).toBeGreaterThan(0);
    const found = files.flatMap((file) => locatorProblems(readFileSync(path.join(dir, file), 'utf8')).map((problem) => `${file}:${problem.line} ${problem.rule}: ${problem.text}`));
    expect(found).toEqual([]);
  });
});
