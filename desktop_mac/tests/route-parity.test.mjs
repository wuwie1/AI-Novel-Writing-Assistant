import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { Navigate, matchRoutes } = require('react-router-dom');
const { build } = createRequire(import.meta.resolve('vite'))('esbuild');
const root = fileURLToPath(new URL('../', import.meta.url));
const documentation = readFileSync(new URL('../docs/route-parity.md', import.meta.url), 'utf8');
const documentedIds = [...documentation.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]);

async function routesFor(worldWizardEnabled) {
  const result = await build({
    stdin: { resolveDir: root, contents: `
      export {appPageIds, createAppRoutes} from '../client/src/router/index.tsx';
      export {macPageOverrides, wrapMacRoutes} from './renderer/src/app/routes.tsx';
    ` },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    define: { 'import.meta.env': JSON.stringify({VITE_WORLD_WIZARD_ENABLED: String(worldWizardEnabled)}) },
    alias: { '@': fileURLToPath(new URL('../../client/src', import.meta.url)) },
    plugins: [{ name: 'page-components', setup(build) {
      build.onResolve({filter: /^@\/(pages\/|components\/layout\/AppLayout$)|^\.\.\/features\//}, args => ({path: args.path, namespace: 'page'}));
      build.onLoad({filter: /.*/, namespace: 'page'}, () => ({contents: 'export default function Page() { return null }'}));
    } }],
  });
  const module = {exports: {}};
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}

for (const enabled of [false, true]) {
  test(`documented Mac routes match the shared router with world wizard ${enabled ? 'enabled' : 'disabled'}`, async () => {
    const {appPageIds, createAppRoutes, wrapMacRoutes, macPageOverrides} = await routesFor(enabled);
    const routes = wrapMacRoutes(createAppRoutes({pageOverrides: macPageOverrides}));
    assert.equal(appPageIds.length, 47);
    assert.deepEqual(documentedIds, appPageIds);
    assert.deepEqual(routes[0].children.map(route => route.id), appPageIds);
    const resolve = pathname => matchRoutes(routes, pathname).at(-1).route;
    const element = pathname => resolve(pathname).element.props.children;
    for (const route of routes[0].children) {
      assert.equal(route.element.props.id, route.id);
      if (route.id in macPageOverrides) assert.equal(route.element.props.children, macPageOverrides[route.id]);
    }
    const redirects = [
      ['/writing-formula', '/style-engine'], ['/chat', '/creative-hub'],
      ['/auto-director/follow-up-center', '/auto-director/follow-ups'],
      ['/auto-director/followup-center', '/auto-director/follow-ups'], ['/unknown-page', '/'],
    ];
    for (const path of ['/worlds/generator', '/worlds/a/workspace']) {
      if (enabled) assert.notEqual(element(path).type, Navigate);
      else redirects.push([path, '/worlds']);
    }
    for (const [from, to] of redirects) {
      assert.equal(element(from).type, Navigate);
      assert.equal(element(from).props.to, to);
      assert.equal(element(from).props.replace, true);
    }
    assert.equal(resolve('/lab/director/preview').id, 'lab/director/:novelId');
  });
}
