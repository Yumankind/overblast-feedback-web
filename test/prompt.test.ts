/**
 * The error prompt's rules (contract §3.6), each driven by a fake clock: not before 10 s, not while
 * typing (waiting up to 30 s), not while hidden, not over the sheet, once a session, once per
 * `minHoursBetween`, seven quiet days after two dismissals, errors a second apart as one, about 8 s
 * on screen with hover holding it, and the log lines.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, type ErrorKind, type KeyConfig } from '../src/config.ts';
import {
  ErrorPrompt,
  PROMPT_MIN_AGE_MS,
  PROMPT_QUIET_MS,
  PROMPT_STORAGE_KEY,
  PROMPT_VISIBLE_MS,
  PROMPT_WAIT_MS,
  type PromptHandlers,
} from '../src/prompt.ts';
import { Clock } from './clock.ts';

const HOUR = 3600 * 1000;

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

interface Page {
  clock: Clock;
  sheetOpen: boolean;
  typing: boolean;
  visible: boolean;
  shows: number;
  showingNow: boolean;
  handlers: PromptHandlers | null;
  opened: number;
  logs: string[];
  storage: MemoryStorage;
  config: KeyConfig;
}

function session(page: Partial<Page> & { storage?: MemoryStorage; clock?: Clock; locallyOff?: boolean } = {}) {
  const p: Page = {
    clock: page.clock ?? new Clock(),
    sheetOpen: false,
    typing: false,
    visible: true,
    shows: 0,
    showingNow: false,
    handlers: null,
    opened: 0,
    logs: [],
    storage: page.storage ?? new MemoryStorage(),
    config: page.config ?? { ...DEFAULT_CONFIG, errorPrompt: { enabled: true, on: ['exception', 'server_error', 'network'], minHoursBetween: 24 } },
  };
  const prompt = new ErrorPrompt({
    now: () => p.clock.now,
    setTimeout: p.clock.setTimeout,
    clearTimeout: p.clock.clearTimeout,
    config: () => p.config,
    locallyOff: page.locallyOff ?? false,
    startedAt: p.clock.now,
    isSheetOpen: () => p.sheetOpen,
    isTyping: () => p.typing,
    isVisible: () => p.visible,
    show: (h) => {
      p.shows++;
      p.showingNow = true;
      p.handlers = h;
    },
    hide: () => {
      p.showingNow = false;
    },
    openSheet: () => p.opened++,
    log: (m) => p.logs.push(m),
    storage: () => p.storage as unknown as Storage,
  });
  return { p, prompt };
}

test('not before 10 s after start; then at once', () => {
  const { p, prompt } = session();
  p.clock.advance(1000);
  prompt.signal('exception');
  p.clock.advance(PROMPT_MIN_AGE_MS - 1000 - 1);
  assert.equal(p.shows, 0);
  p.clock.advance(1);
  assert.equal(p.shows, 1);
  assert.deepEqual(p.logs, ['error prompt shown']);
  // Long after start: shown at once.
  const late = session();
  late.p.clock.advance(60_000);
  late.prompt.signal('exception');
  late.p.clock.advance(0);
  assert.equal(late.p.shows, 1);
});

test('only when the key has it on, for that kind, and the integrator has not turned it off', () => {
  const off = session({ config: DEFAULT_CONFIG });
  off.p.clock.advance(20_000);
  off.prompt.signal('exception');
  off.p.clock.advance(60_000);
  assert.equal(off.p.shows, 0, 'off by default');

  const onlyExceptions = session({ config: { ...DEFAULT_CONFIG, errorPrompt: { enabled: true, on: ['exception'], minHoursBetween: 24 } } });
  onlyExceptions.p.clock.advance(20_000);
  for (const k of ['server_error', 'network'] as ErrorKind[]) onlyExceptions.prompt.signal(k);
  onlyExceptions.p.clock.advance(60_000);
  assert.equal(onlyExceptions.p.shows, 0, 'not a kind the key lists');
  onlyExceptions.prompt.signal('exception');
  onlyExceptions.p.clock.advance(0);
  assert.equal(onlyExceptions.p.shows, 1);

  const local = session({ locallyOff: true });
  local.p.clock.advance(20_000);
  local.prompt.signal('exception');
  local.p.clock.advance(60_000);
  assert.equal(local.p.shows, 0, 'errorPrompt: false wins');
});

test('while a text field has focus it waits, then shows when typing stops', () => {
  const { p, prompt } = session();
  p.clock.advance(20_000);
  p.typing = true;
  prompt.signal('exception');
  p.clock.advance(PROMPT_WAIT_MS - 5000);
  assert.equal(p.shows, 0);
  p.typing = false;
  p.clock.advance(500);
  assert.equal(p.shows, 1);
});

test('typing for 30 s: it gives up, and a later error may try again', () => {
  const { p, prompt } = session();
  p.clock.advance(20_000);
  p.typing = true;
  prompt.signal('exception');
  p.clock.advance(PROMPT_WAIT_MS + 1000);
  p.typing = false;
  p.clock.advance(60_000);
  assert.equal(p.shows, 0, 'gave up');
  prompt.signal('exception');
  p.clock.advance(0);
  assert.equal(p.shows, 1);
});

test('a hidden page waits the same way; the open sheet means no prompt', () => {
  const hidden = session();
  hidden.p.clock.advance(20_000);
  hidden.p.visible = false;
  hidden.prompt.signal('network');
  hidden.p.clock.advance(10_000);
  assert.equal(hidden.p.shows, 0);
  hidden.p.visible = true;
  hidden.p.clock.advance(500);
  assert.equal(hidden.p.shows, 1);

  const sheet = session();
  sheet.p.clock.advance(20_000);
  sheet.p.sheetOpen = true;
  sheet.prompt.signal('exception');
  sheet.p.clock.advance(60_000);
  assert.equal(sheet.p.shows, 0);
});

test('errors less than a second apart are one prompt', () => {
  const { p, prompt } = session();
  p.clock.advance(20_000);
  p.sheetOpen = true;
  prompt.signal('exception'); // given up: the sheet is open
  p.clock.advance(0);
  p.sheetOpen = false;
  p.clock.advance(500);
  prompt.signal('exception'); // half a second later: the same trouble
  p.clock.advance(5000);
  assert.equal(p.shows, 0);
  prompt.signal('exception');
  p.clock.advance(0);
  assert.equal(p.shows, 1);
});

test('once a session', () => {
  const { p, prompt } = session({ config: { ...DEFAULT_CONFIG, errorPrompt: { enabled: true, on: ['exception'], minHoursBetween: 0 } } });
  p.clock.advance(20_000);
  prompt.signal('exception');
  p.clock.advance(PROMPT_VISIBLE_MS + 1000);
  prompt.signal('exception');
  p.clock.advance(60_000);
  assert.equal(p.shows, 1);
});

test('once per minHoursBetween on the device', () => {
  const storage = new MemoryStorage();
  const clock = new Clock();
  const a = session({ storage, clock });
  clock.advance(20_000);
  a.prompt.signal('exception');
  clock.advance(0);
  assert.equal(a.p.shows, 1);
  assert.equal(JSON.parse(storage.getItem(PROMPT_STORAGE_KEY)!).lastShown, 20_000);

  clock.advance(23 * HOUR);
  const b = session({ storage, clock });
  clock.advance(20_000);
  b.prompt.signal('exception');
  clock.advance(60_000);
  assert.equal(b.p.shows, 0, 'within 24 hours');

  clock.advance(2 * HOUR);
  const c = session({ storage, clock });
  clock.advance(20_000);
  c.prompt.signal('exception');
  clock.advance(0);
  assert.equal(c.p.shows, 1, 'a day later');
});

test('closed twice without reporting: quiet for seven days; reporting resets the count', () => {
  const storage = new MemoryStorage();
  const clock = new Clock();
  const config: KeyConfig = { ...DEFAULT_CONFIG, errorPrompt: { enabled: true, on: ['exception'], minHoursBetween: 0 } };
  const showAndThen = (act: 'close' | 'report' | null): number => {
    const s = session({ storage, clock, config });
    clock.advance(20_000);
    s.prompt.signal('exception');
    clock.advance(0);
    if (s.p.shows && act) s.p.handlers![act]();
    if (act === 'close') assert.ok(s.p.logs.includes('error prompt dismissed'));
    return s.p.shows;
  };
  assert.equal(showAndThen('close'), 1);
  assert.equal(showAndThen('report'), 1, 'reporting resets the count');
  assert.equal(showAndThen('close'), 1);
  assert.equal(showAndThen('close'), 1, 'the second close in a row');
  assert.equal(showAndThen(null), 0, 'quiet now');
  clock.advance(PROMPT_QUIET_MS - 10 * HOUR);
  assert.equal(showAndThen(null), 0, 'still quiet after six days');
  clock.advance(11 * HOUR);
  assert.equal(showAndThen(null), 1, 'after seven days');
});

test('about 8 s on screen; the pointer over it holds it; Report opens the sheet', () => {
  const { p, prompt } = session();
  p.clock.advance(20_000);
  prompt.signal('exception');
  p.clock.advance(0);
  assert.ok(p.showingNow);
  p.clock.advance(PROMPT_VISIBLE_MS - 3000);
  p.handlers!.hold(true);
  p.clock.advance(60_000);
  assert.ok(p.showingNow, 'held while the pointer is over it');
  p.handlers!.hold(false);
  p.clock.advance(2900);
  assert.ok(p.showingNow, 'the time it had left, at least two seconds');
  p.clock.advance(200);
  assert.ok(!p.showingNow, 'gone by itself');
  assert.equal(p.logs.at(-1), 'error prompt went away unanswered');

  const r = session();
  r.p.clock.advance(20_000);
  r.prompt.signal('server_error');
  r.p.clock.advance(0);
  r.p.handlers!.report();
  assert.equal(r.p.opened, 1);
  assert.ok(!r.p.showingNow);
  // The sheet opened another way while the pill was up: it goes, and it is not a dismissal.
  const s = session();
  s.p.clock.advance(20_000);
  s.prompt.signal('exception');
  s.p.clock.advance(0);
  s.prompt.sheetOpened();
  assert.ok(!s.p.showingNow);
  assert.ok(!s.p.logs.includes('error prompt dismissed'));
});
