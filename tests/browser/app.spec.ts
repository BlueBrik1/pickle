import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
async function sample(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try the sample' }).click();
  await expect(page.getByLabel('What are you changing?')).toBeVisible();
  await page.getByRole('button', { name: 'Find starting files' }).click();
  await expect(page.getByRole('heading', { name: 'Confirm starting files.' })).toBeVisible();
  await page.getByRole('button', { name: 'Analyze impact' }).click();
  await expect(page.getByRole('heading', { name: 'Change impact.' })).toBeVisible();
}
test('sample to evidence, filters, user review, all exports and route recovery', async ({
  page,
}) => {
  await sample(page);
  await expect(page.getByLabel('Dependency graph')).toBeVisible();
  const nodes = page.locator('.react-flow__node');
  await expect(nodes.first()).toBeVisible();
  await nodes.first().click();
  await expect(page.getByLabel('File inspector')).toContainText('Supporting evidence');
  await page
    .getByRole('button', { name: 'Files', exact: false })
    .filter({ hasText: /^Files/ })
    .click();
  await page.locator('tbody .file-link').first().click();
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('source snapshot');
  await expect(page.locator('.source-lines')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByPlaceholder('Search paths or symbols…').fill('no-file-will-match');
  await expect(page.getByText(/0 of \d+ files/)).toBeVisible();
  await page.getByRole('button', { name: 'Reset filters', exact: true }).first().click();
  await expect(page.locator('tbody tr').first()).toBeVisible();
  await page
    .getByRole('button', { name: 'Plan', exact: false })
    .filter({ hasText: /^Plan/ })
    .click();
  const checkbox = page.locator('.task-row input[type=checkbox]').first();
  await checkbox.check();
  await expect(page.getByText('Completed by user', { exact: true })).toBeVisible();
  const note = page.locator('.task-row textarea').first();
  await note.fill('Review ownership before implementation.');
  await note.blur();
  await expect(page.getByText('Completed by user · includes user edits')).toBeVisible();
  const results: Record<string, string> = {};
  for (const [name, filename] of [
    ['Download Markdown report', 'pickle-impact-report.md'],
    ['Download JSON result', 'pickle-analysis.json'],
    ['Export for Bob', 'pickle-bob-handoff.md'],
  ]) {
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name, exact: true }).click();
    const file = await downloaded;
    expect(file.suggestedFilename()).toBe(filename);
    results[filename] = await readFile((await file.path())!, 'utf8');
    expect(results[filename]).toContain('Review ownership before implementation');
  }
  const json = JSON.parse(results['pickle-analysis.json']);
  expect(json.result.schemaVersion).toBe('1.0');
  expect(json.result.impacts.length).toBeGreaterThan(3);
  expect(results['pickle-bob-handoff.md']).toContain('untrusted');
  expect(results['pickle-impact-report.md']).toContain('User');
  const url = page.url();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Change impact.' })).toBeVisible();
  expect(page.url()).toBe(url);
  await page.goBack();
  await expect(page.getByLabel('What are you changing?')).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Change impact.' })).toBeVisible();
});
test('desktop and mobile visuals, exact fonts and no viewport overflow', async ({ page }) => {
  await mkdir('docs/screenshots', { recursive: true });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'docs/screenshots/start-1440.png', fullPage: true });
  expect(await page.locator('h1').evaluate((e) => getComputedStyle(e).fontFamily)).toContain(
    'Source Serif Pro',
  );
  expect(await page.locator('body').evaluate((e) => getComputedStyle(e).fontFamily)).toContain(
    'Work Sans',
  );
  expect(
    await page.evaluate(
      () =>
        document.fonts.check('400 16px "Source Serif Pro"') &&
        document.fonts.check('400 16px "Work Sans"'),
    ),
  ).toBe(true);
  await sample(page);
  await page.screenshot({ path: 'docs/screenshots/result-1440.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Inspect selected file' }).click();
  await expect(page.getByRole('dialog')).toContainText('Supporting evidence');
  await page.keyboard.press('Escape');
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: 'docs/screenshots/result-1280.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByLabel('Affected files')).toBeVisible();
  await page.locator('tbody .file-link').first().click();
  await expect(page.getByLabel('File inspector')).toContainText('Supporting evidence');
  await page.screenshot({ path: 'docs/screenshots/result-390.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused();
});
test('keyboard, API error recovery, clipboard fallback and unknown route', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try the sample' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('What are you changing?')).toBeVisible();
  await page.route(
    '**/candidates',
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Test service unavailable' } }),
      }),
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Find starting files' }).click();
  await expect(page.getByRole('alert')).toContainText('Test service unavailable');
  await page.getByRole('button', { name: 'Dismiss & reconnect' }).click();
  await page.getByRole('button', { name: 'Find starting files' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Analyze impact' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Change impact.' })).toBeVisible();
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }),
  );
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Copy Bob handoff' }).click();
  await expect(page.getByLabel('Text to copy')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/unknown');
  await expect(page.getByRole('heading', { name: 'This page is unavailable.' })).toBeVisible();
});
test('local folder picker excludes secrets and honors selected root', async ({ page }) => {
  const folder = await mkdtemp(path.join(tmpdir(), 'pickle-browser-'));
  await mkdir(path.join(folder, 'nested'));
  await writeFile(
    path.join(folder, 'nested', 'account.ts'),
    'export const accountStatus = "active";',
  );
  await writeFile(
    path.join(folder, 'consumer.ts'),
    'import { accountStatus } from "./nested/account"; export const status = accountStatus;',
  );
  await writeFile(path.join(folder, '.env.example'), 'TOKEN=never-transmit-this\n');
  await writeFile(path.join(folder, '.env'), 'REAL_SECRET=never-retain-this');
  await writeFile(
    path.join(folder, 'unsafe.md'),
    '<script>window.__pickleInjected = true</script>\n`nested/account.ts`',
  );
  try {
    await page.goto('/');
    await page.locator('input[type=file]').setInputFiles(folder);
    await expect(page.getByLabel('What are you changing?')).toBeVisible();
    const meta = await page.request.get('/api/session');
    const data = await meta.json();
    const repo = data.repositories[0];
    expect(repo.scan.skippedFiles).toBeGreaterThan(0);
    expect(repo.files.some((f: { path: string }) => f.path === 'nested/account.ts')).toBe(true);
    const env = repo.files.find((f: { path: string }) => f.path === '.env.example');
    const source = await page.request.get(`/api/repositories/${repo.id}/source/${env.id}`);
    expect(await source.text()).not.toContain('never-transmit');
    await page.getByRole('button', { name: 'Find starting files' }).click();
    await page.getByPlaceholder('Search by path…').fill('unsafe.md');
    await page.getByRole('button', { name: 'Inspect unsafe.md', exact: true }).click();
    await expect(page.locator('.source-lines')).toContainText(
      '<script>window.__pickleInjected = true</script>',
    );
    expect(await page.evaluate(() => Reflect.get(window, '__pickleInjected'))).toBeUndefined();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Clear project' }).click();
    await expect(page.getByRole('heading', { name: /Know what your/ })).toBeVisible();
    expect((await page.request.get(`/api/repositories/${repo.id}`)).status()).toBe(404);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
test('hosted demo has sample only and server rejects direct imports', async ({ page }) => {
  await page.goto('http://127.0.0.1:3002');
  await expect(
    page.getByText('Hosted demo: only the bundled public sample is enabled.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose project folder' })).toHaveCount(0);
  expect(
    (
      await page.request.post('http://127.0.0.1:3002/api/repositories/import', {
        data: { name: 'Forbidden', files: [{ relativePath: 'x.ts', content: 'export const x=1' }] },
      })
    ).status(),
  ).toBe(403);
  await page.getByRole('button', { name: 'Try the sample' }).click();
  await expect(page.getByLabel('What are you changing?')).toBeVisible();
});
test('cancel a queued real analysis and start again without a stale result', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try the sample' }).click();
  await expect(page.getByLabel('What are you changing?')).toBeVisible();
  await page.getByRole('button', { name: 'Find starting files' }).click();
  await expect(page.getByRole('button', { name: 'Analyze impact' })).toBeEnabled();
  const files = Array.from({ length: 1000 }, (_, i) => ({
    relativePath: `part${i}.ts`,
    content: Array.from({ length: 70 }, (_, j) => `export const value${j} = ${j};`).join('\n'),
  }));
  const first = await page.request.post('/api/repositories/import', {
    data: { name: 'Queue workload one', files },
  });
  const second = await page.request.post('/api/repositories/import', {
    data: { name: 'Queue workload two', files },
  });
  expect(first.status()).toBe(202);
  expect(second.status()).toBe(202);
  await page.getByRole('button', { name: 'Analyze impact' }).click();
  await page.getByRole('button', { name: 'Cancel analysis', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Analysis canceled.' })).toBeVisible();
  const canceledUrl = page.url();
  await page.request.delete(`/api/repositories/${(await first.json()).id}`);
  await page.request.delete(`/api/repositories/${(await second.json()).id}`);
  await page.getByRole('button', { name: /Start another analysis/ }).click();
  await page.getByRole('button', { name: 'Find starting files' }).click();
  await page.getByRole('button', { name: 'Analyze impact' }).click();
  await expect(page.getByRole('heading', { name: 'Change impact.' })).toBeVisible();
  expect(page.url()).not.toBe(canceledUrl);
  await page.goto(canceledUrl);
  await expect(page.getByRole('heading', { name: 'Analysis canceled.' })).toBeVisible();
});

test('graph caps preserve every file in paginated results and JSON', async ({ page }) => {
  await page.goto('/');
  const files = [
    { relativePath: 'core.ts', content: 'export const core = 1;' },
    ...Array.from({ length: 130 }, (_, i) => ({
      relativePath: `consumer${String(i).padStart(3, '0')}.ts`,
      content: 'import {core} from "./core"; export const value = core;',
    })),
  ];
  const imported = await page.request.post('/api/repositories/import', {
    data: { name: 'Graph limits', files },
  });
  expect(imported.status()).toBe(202);
  const id = (await imported.json()).id;
  let project: any;
  await expect
    .poll(async () => {
      project = await (await page.request.get(`/api/repositories/${id}`)).json();
      return project.state;
    })
    .toBe('completed');
  const posted = await page.request.post('/api/analyses', {
    data: {
      repositoryId: id,
      requestText: 'Change the core value',
      seedFileIds: [project.files.find((f: { path: string }) => f.path === 'core.ts').id],
      settings: { maxDepth: 3, includeTypeOnly: true },
    },
  });
  const analysis = (await posted.json()).id;
  await page.goto(`/analyses/${analysis}`);
  await expect(page.getByRole('heading', { name: 'Change impact.' })).toBeVisible();
  await expect(page.getByText(/Graph display capped: 11 files/)).toBeVisible();
  expect(await page.locator('.react-flow__node').count()).toBe(120);
  await page.getByRole('button', { name: /^Files/ }).click();
  await expect(page.getByText('Page 1 of 6')).toBeVisible();
  for (let i = 0; i < 5; i++) await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Page 6 of 6')).toBeVisible();
  expect(await page.locator('tbody tr').count()).toBe(6);
  const exported = await (
    await page.request.get(`/api/analyses/${analysis}/export?format=json`)
  ).json();
  expect(exported.result.impacts).toHaveLength(131);
  expect(exported.result.relationships).toHaveLength(130);
});

test('a cited test outside the bounded impact set opens actual source', async ({ page }) => {
  await page.goto('/');
  const imported = await page.request.post('/api/repositories/import', {
    data: {
      name: 'Test context',
      files: [
        {
          relativePath: 'feature.ts',
          content: 'import { utility } from "./utility"; export const feature = utility;',
        },
        { relativePath: 'utility.ts', content: 'export const utility = 1;' },
        {
          relativePath: 'integration.spec.ts',
          content: 'import { utility } from "./utility"; console.assert(utility === 1);',
        },
      ],
    },
  });
  const id = (await imported.json()).id;
  let project: any;
  await expect
    .poll(async () => {
      project = await (await page.request.get(`/api/repositories/${id}`)).json();
      return project.state;
    })
    .toBe('completed');
  const response = await page.request.post('/api/analyses', {
    data: {
      repositoryId: id,
      requestText: 'Change the feature interface',
      seedFileIds: [project.files.find((f: { path: string }) => f.path === 'feature.ts').id],
      settings: { maxDepth: 1, includeTypeOnly: true },
    },
  });
  await page.goto(`/analyses/${(await response.json()).id}`);
  await expect(page.getByRole('heading', { name: 'Change impact.' })).toBeVisible();
  await page.getByRole('button', { name: 'Checks', exact: true }).click();
  await page.getByRole('button', { name: 'integration.spec.ts', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('console.assert(utility === 1)');
});
