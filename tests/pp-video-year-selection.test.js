import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
const start = source.indexOf('  // Reset before paint so the previous year');
const end = source.indexOf('  // Load past-paper catalog when subject changes', start);
assert.ok(start !== -1 && end > start, 'PP video effects must be present');
const videoEffects = source.slice(start, end);

function createHarness() {
  const state = {
    materialMode: 'by-years',
    selectedBook: 'chemistry-winter2',
    pastPaperYear: '2024',
    ppVideoOpen: false,
    ppVideoSections: [],
    ppVideoLoading: false,
    ppVideoSection: '',
    ppVideoQuestion: '',
  };
  const requests = [];
  const effects = [];
  let yearRef;

  const setState = (key) => (value) => {
    state[key] = typeof value === 'function' ? value(state[key]) : value;
  };

  const render = (changes = {}) => {
    Object.assign(state, changes);
    const nextEffects = [];
    const registerEffect = (callback, deps) => nextEffects.push({ callback, deps: Array.from(deps) });
    vm.runInNewContext(videoEffects, {
      ...state,
      MATERIAL_PP_YEARS: 'by-years',
      useRef: (initial) => {
        if (!yearRef) yearRef = { current: initial };
        return yearRef;
      },
      useLayoutEffect: registerEffect,
      useEffect: registerEffect,
      setPpVideoSections: setState('ppVideoSections'),
      setPpVideoLoading: setState('ppVideoLoading'),
      setPpVideoSection: setState('ppVideoSection'),
      setPpVideoQuestion: setState('ppVideoQuestion'),
      fetchJson: (url) => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
      encodeURIComponent,
    });

    nextEffects.forEach((effect, index) => {
      const previous = effects[index];
      if (previous && effect.deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return;
      previous?.cleanup?.();
      effects[index] = { deps: effect.deps, cleanup: effect.callback() };
    });
  };

  const respond = async (year, sections, error = null) => {
    const request = requests.find((entry) => (
      !entry.resolved && new URL(entry.url, 'http://example.test/').searchParams.get('year') === year
    ));
    assert.ok(request, `expected a video request for ${year}`);
    request.resolved = true;
    if (error) request.reject(error);
    else request.resolve({ sections });
    await new Promise((resolve) => setImmediate(resolve));
  };

  return { state, requests, render, respond };
}

function videos(year, p1a = ['1', '2', '3'], p1b = ['1', '2', '3']) {
  return [
    ...(p1a ? [{ section: 'PIA', label: 'P1A', questions: p1a.map((question) => ({
      question, url: `/${year}-PIA-Q${question}.mp4`,
    })) }] : []),
    ...(p1b ? [{ section: 'PIB', label: 'P1B', questions: p1b.map((question) => ({
      question, url: `/${year}-PIB-Q${question}.mp4`,
    })) }] : []),
  ];
}

function activeVideo(state) {
  return state.ppVideoSections
    .find((section) => section.section === state.ppVideoSection)
    ?.questions.find((question) => question.question === state.ppVideoQuestion)?.url;
}

for (const previousSection of ['PIA', 'PIB']) {
  test(`changing year with video open resets ${previousSection} Q3 to the new P1A Q1`, async () => {
    const app = createHarness();
    app.render();
    await app.respond('2024', videos('2024'));
    app.render({ ppVideoOpen: true, ppVideoSection: previousSection, ppVideoQuestion: '3' });
    assert.equal(activeVideo(app.state), `/2024-${previousSection}-Q3.mp4`);

    app.render({ pastPaperYear: '2025' });
    assert.equal(app.state.ppVideoSections.length, 0);
    assert.equal(app.state.ppVideoLoading, true);
    assert.equal(app.state.ppVideoSection, 'PIA');
    assert.equal(app.state.ppVideoQuestion, '1');
    assert.equal(activeVideo(app.state), undefined);

    await app.respond('2025', videos('2025'));
    assert.equal(app.state.ppVideoLoading, false);
    assert.equal(activeVideo(app.state), '/2025-PIA-Q1.mp4');
  });
}

test('opening or closing video without changing year keeps the selected question', async () => {
  const app = createHarness();
  app.render();
  await app.respond('2024', videos('2024'));
  app.render({ ppVideoOpen: true, ppVideoSection: 'PIA', ppVideoQuestion: '2' });
  app.render({ ppVideoOpen: false });
  app.render({ ppVideoOpen: true });
  app.render({ pastPaperYear: '2024' });
  assert.equal(activeVideo(app.state), '/2024-PIA-Q2.mp4');
  assert.equal(app.requests.length, 1);
});

test('changing year while video is closed preserves the existing selection when available', async () => {
  const app = createHarness();
  app.render();
  await app.respond('2024', videos('2024'));
  app.render({ ppVideoOpen: true, ppVideoSection: 'PIB', ppVideoQuestion: '2' });
  app.render({ ppVideoOpen: false });
  app.render({ pastPaperYear: '2025' });
  await app.respond('2025', videos('2025'));
  app.render({ ppVideoOpen: true });
  assert.equal(activeVideo(app.state), '/2025-PIB-Q2.mp4');
});

test('changing year outside PP-years does not reset the video selection', async () => {
  const app = createHarness();
  app.render();
  await app.respond('2024', videos('2024'));
  app.render({ ppVideoOpen: true, ppVideoSection: 'PIB', ppVideoQuestion: '3' });
  app.render({ materialMode: 'by-topics' });
  app.render({ pastPaperYear: '2025' });
  assert.equal(app.state.ppVideoSection, 'PIB');
  assert.equal(app.state.ppVideoQuestion, '3');

  app.render({ materialMode: 'by-years' });
  await app.respond('2025', videos('2025'));
  assert.equal(activeVideo(app.state), '/2025-PIB-Q3.mp4');
});

for (const [description, sections, expectedUrl] of [
  ['P1A Q1 is unavailable', videos('2025', ['2', '3']), '/2025-PIA-Q2.mp4'],
  ['P1A is unavailable', videos('2025', null, ['2', '3']), '/2025-PIB-Q2.mp4'],
  ['no videos are available', [], undefined],
]) {
  test(`year change falls back when ${description}`, async () => {
    const app = createHarness();
    app.render();
    await app.respond('2024', videos('2024'));
    app.render({ ppVideoOpen: true, ppVideoSection: 'PIB', ppVideoQuestion: '3' });
    app.render({ pastPaperYear: '2025' });
    await app.respond('2025', sections);
    assert.equal(activeVideo(app.state), expectedUrl);
  });
}

test('a late response for an older year cannot replace the new P1A Q1 video', async () => {
  const app = createHarness();
  app.render();
  await app.respond('2024', videos('2024'));
  app.render({ ppVideoOpen: true, ppVideoSection: 'PIA', ppVideoQuestion: '3' });
  app.render({ pastPaperYear: '2025' });
  app.render({ pastPaperYear: '2023' });

  await app.respond('2023', videos('2023'));
  await app.respond('2025', videos('2025'));
  assert.equal(activeVideo(app.state), '/2023-PIA-Q1.mp4');
});

test('a cancelled request cannot end loading for a newer year', async () => {
  const app = createHarness();
  app.render();
  await app.respond('2024', videos('2024'));
  app.render({ ppVideoOpen: true, ppVideoSection: 'PIB', ppVideoQuestion: '3' });
  app.render({ pastPaperYear: '2025' });
  app.render({ pastPaperYear: '2023' });

  await app.respond('2025', videos('2025'));
  assert.equal(app.state.ppVideoLoading, true);
  assert.equal(app.state.ppVideoSections.length, 0);
  await app.respond('2023', videos('2023'));
  assert.equal(app.state.ppVideoLoading, false);
  assert.equal(activeVideo(app.state), '/2023-PIA-Q1.mp4');
});

test('a failed video request ends loading without showing the previous year', async () => {
  const app = createHarness();
  app.render();
  await app.respond('2024', videos('2024'));
  app.render({ ppVideoOpen: true, ppVideoSection: 'PIA', ppVideoQuestion: '3' });
  app.render({ pastPaperYear: '2025' });
  await app.respond('2025', null, new Error('request failed'));
  assert.equal(app.state.ppVideoLoading, false);
  assert.equal(activeVideo(app.state), undefined);
});
