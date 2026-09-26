import { spawn } from 'node:child_process';
const children = [];
function run(args) {
  const p = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
  children.push(p);
  return p;
}
const compile = run(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json']);
compile.on('exit', (code) => {
  if (code) process.exit(code);
  run(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json', '--watch']);
  run(['--watch', 'dist-server/server/index.js']);
  run(['node_modules/vite/bin/vite.js']);
});
function stop() {
  for (const p of children) p.kill();
  process.exit();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
