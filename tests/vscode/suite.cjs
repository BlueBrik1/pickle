// Runs inside the Extension Development Host (see run.mjs). Plain assertions; no test framework.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const until = async (what, check, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

const tests = {
  async activates() {
    const ext = vscode.extensions.getExtension('pickle-local.pickle-impact');
    assert.ok(ext, 'extension present');
    await ext.activate();
    assert.ok(ext.isActive);
  },

  async 'registers its commands'() {
    const all = new Set(await vscode.commands.getCommands(true));
    for (const id of [
      'pickle.analyzeChanges',
      'pickle.previewChange',
      'pickle.showImpact',
      'pickle.showContext',
      'pickle.scanDesign',
      'pickle.reviewFixes',
      'pickle.revertFix',
      'pickle.preCommitReview',
      'pickle.runVerification',
      'pickle.configureIntegrations',
      'pickle.report.focus',
    ])
      assert.ok(all.has(id), id);
  },

  async 'analyzes uncommitted changes without any external account'() {
    await vscode.commands.executeCommand('pickle.analyzeChanges');
    const r = await vscode.commands.executeCommand('pickle.getReport');
    assert.equal(r.mode, 'review');
    assert.deepEqual(r.changed.map((c) => c.path), ['src/checkout/CheckoutButton.tsx']);
    assert.deepEqual(r.impact.confirmed.map((e) => `${e.path}:${e.line}`), ['src/checkout/CheckoutPage.tsx:2', 'src/checkout/index.ts:1']);
    assert.equal(r.sources.find((s) => s.name.startsWith('GitHub')).state, 'off');
    assert.equal(r.sources.find((s) => s.name === 'Fixture').state, 'used');
  },

  async 'renders the sidebar sections'() {
    await vscode.commands.executeCommand('pickle.report.focus');
    const tree = await vscode.commands.executeCommand('pickle.getTree');
    assert.deepEqual(tree.map((n) => n.label), ['Change', 'Impact', 'Context', 'Design', 'Risk', 'Verify']);
    const impact = tree.find((n) => n.label === 'Impact');
    assert.deepEqual(impact.children.map((n) => n.label).slice(0, 2), ['Confirmed', 'Predicted']);
    assert.match(tree.find((n) => n.label === 'Risk').children[0].label, /disabled=\{submitting\}/);
  },

  async 'shows diagnostics at the drifting line'() {
    const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const uri = vscode.Uri.file(path.join(ws, 'src', 'checkout', 'CheckoutButton.tsx'));
    const diags = vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'Pickle');
    const design = diags.find((d) => d.message.startsWith('Design:'));
    assert.ok(design, JSON.stringify(diags.map((d) => d.message)));
    assert.equal(design.range.start.line, 10);
    assert.match(design.message, /#2a6bf0.*#2563eb/);
  },

  async 'opens the source location when a finding is clicked'() {
    const tree = await vscode.commands.executeCommand('pickle.getTree');
    const first = tree.find((n) => n.label === 'Impact').children[0].children[0];
    assert.equal(first.label, 'src/checkout/CheckoutPage.tsx:2');
    await vscode.commands.executeCommand(first.command, ...first.arguments);
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor.document.fileName.endsWith(path.join('checkout', 'CheckoutPage.tsx')));
    assert.equal(editor.selection.active.line, 1);
    assert.match(editor.document.lineAt(1).text, /CheckoutButton/);
  },

  async 'previews a planned change'() {
    await vscode.commands.executeCommand('pickle.previewChange', 'Redesign the checkout button and update its submission behavior');
    const r = await vscode.commands.executeCommand('pickle.getReport');
    assert.equal(r.mode, 'preview');
    assert.ok(r.impact.confirmed.some((e) => e.path === 'src/checkout/CheckoutButton.tsx'));
    assert.ok(r.context.some((c) => c.title.includes('REQ-CHK-1')));
  },

  async 'file changes on disk trigger a debounced re-analysis'() {
    const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
    fs.writeFileSync(path.join(ws, 'src', 'auth', 'session.ts'), fs.readFileSync(path.join(ws, 'src', 'auth', 'session.ts'), 'utf8') + '\nexport const SESSION_COOKIE = "sid";\n');
    const r = await until('auto analysis', async () => {
      const rep = await vscode.commands.executeCommand('pickle.getReport');
      return rep.mode === 'review' && rep.changed.some((c) => c.path === 'src/auth/session.ts') && rep;
    });
    assert.ok(r.changed.some((c) => c.path === 'src/checkout/CheckoutButton.tsx'));
  },

  async 'never installs hooks on its own'() {
    const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
    assert.equal(fs.existsSync(path.join(ws, '.git', 'hooks', 'pre-commit')), false);
    assert.equal(fs.existsSync(path.join(ws, '.claude', 'settings.local.json')), false);
  },
};

exports.run = async () => {
  const failures = [];
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failures.push(name);
      console.log(`  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e}`);
    }
  }
  console.log(`${Object.keys(tests).length - failures.length}/${Object.keys(tests).length} VS Code integration tests passed`);
  if (failures.length) throw new Error(`${failures.length} failed: ${failures.join(', ')}`);
};
