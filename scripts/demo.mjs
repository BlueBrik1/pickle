// Demo driver: node scripts/demo.mjs <setup|change|restore-guard|reset>
//   setup          copy demo/checkout-app to .demo/checkout-app and commit it as a fresh Git repo
//   change         apply the "agent's" checkout-button redesign (stage 3)
//   restore-guard  put back `disabled={submitting}` the redesign dropped (developer's resolution)
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, '.demo', 'checkout-app');
const git = (...args) =>
  execFileSync('git', ['-c', 'user.name=Pickle Demo', '-c', 'user.email=demo@example.invalid', ...args], { cwd: target, stdio: 'pipe' });
const button = path.join(target, 'src', 'checkout', 'CheckoutButton.tsx');

switch (process.argv[2]) {
  case 'setup':
    rmSync(target, { recursive: true, force: true });
    cpSync(path.join(root, 'demo', 'checkout-app'), target, { recursive: true });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'Checkout demo baseline');
    console.log(`Demo repository ready: ${target}\nOpen it in the Extension Development Host (F5) or run:\n  node dist-ext/cli.cjs preview --root "${target}" "Redesign the checkout button and update its submission behavior"`);
    break;
  case 'change':
    cpSync(path.join(root, 'demo', 'agent-change'), target, { recursive: true });
    console.log('Applied the agent change to src/checkout/CheckoutButton.tsx (uncommitted).');
    break;
  case 'restore-guard': {
    const text = readFileSync(button, 'utf8');
    if (text.includes('disabled={submitting}')) console.log('Guard already present.');
    else {
      writeFileSync(button, text.replace('      aria-busy={submitting}', '      disabled={submitting}\n      aria-busy={submitting}'));
      console.log('Restored disabled={submitting} in CheckoutButton.tsx.');
    }
    break;
  }
  case 'reset':
    rmSync(target, { recursive: true, force: true });
    console.log('Removed .demo/checkout-app.');
    break;
  default:
    console.error('Usage: node scripts/demo.mjs <setup|change|restore-guard|reset>');
    process.exit(2);
}
