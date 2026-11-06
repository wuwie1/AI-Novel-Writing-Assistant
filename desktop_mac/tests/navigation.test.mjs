import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const macRoot = fileURLToPath(new URL('../', import.meta.url));
// 共享 API 的运行依赖由 client 声明，临时 bundle 在同一解析范围内运行。
const output = path.resolve(macRoot, '../client/tests', `.mac-navigation-${process.pid}.mjs`);
let mount, dom;
const restore = [];

before(async () => {
  // Node 组件回归；API、原生桥和浮层外观均隔离，不访问真实服务或浏览器。
  const { JSDOM } = createRequire(import.meta.url)('jsdom');
  dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    restore.push(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  const { build } = createRequire(import.meta.resolve('vite'))('esbuild');
  await build({
    stdin: { resolveDir: macRoot, loader: 'tsx', contents: `
      import React,{act} from 'react';
      import {createRoot} from 'react-dom/client';
      import {createMemoryRouter,RouterProvider} from 'react-router-dom';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
      import {MacDocumentProtection} from './renderer/src/platform/MacDocumentProtection';
      import {MacAppLayout} from './renderer/src/shell/MacAppLayout';
      import MacTaskRecords from './renderer/src/features/tasks/MacTaskRecords';
      import {useDocumentGuard} from '@/platform';
      import {apiClient} from '@/api/client';
      export async function mount(initial='/settings/models') {
        const requests=[],messages=[];
        window.__AI_NOVEL_MAC__={protocolVersion:1,mode:'local',backendIdentity:'test',postMessage:message=>messages.push(message)};
        const novel={id:'book-a',title:'测试作品',narrativeForm:'long_novel'};
        apiClient.defaults.adapter=async config=>{
          requests.push({url:config.url,method:config.method,params:config.params});
          let data;
          if(config.url==='/novels') data={items:[novel],total:1};
          else if(config.url==='/novels/book-a') data=novel;
          else if(config.url==='/novels/book-a/chapters') data=[{id:'chapter-a',title:'测试章节',order:1}];
          else if(config.url==='/creative-hub/threads') data=[{id:'thread-a',title:'构思对话'}];
          else if(config.url==='/director-next/records') data=[{runId:'run-a',headline:'测试创作记录',statusLabel:'完成',progressLabel:'1章',directorRoute:'/lab/director/book-a'}];
          else if(config.url==='/drama/projects' || config.url==='/comic/projects') data=[{id:'project-a',title:config.url.startsWith('/drama')?'短剧项目甲':'漫画项目甲'}];
          else if(config.url==='/tasks') data={items:[],nextCursor:null};
          else throw new Error('Unexpected test request: '+config.url);
          return {data:{success:true,data},status:200,statusText:'OK',headers:{},config};
        };
        let setGuard, failSave=false, saveCount=0;
        function Editor(){
          const [guard,update]=React.useState({dirty:false,busy:false});setGuard=update;
          useDocumentGuard({label:'旧页面元数据',dirty:false,manualReview:true});
          useDocumentGuard({label:'测试正文',...guard,
            save:async()=>{saveCount++;if(failSave)throw Error('测试保存失败');setGuard({dirty:false,busy:false})},
            discard:()=>{setGuard({dirty:false,busy:false})},
          });
          return <div>编辑区</div>;
        }
        const router=createMemoryRouter([{element:<MacDocumentProtection><MacAppLayout/></MacDocumentProtection>,children:[
          {path:'tasks',element:<MacTaskRecords/>},{path:'*',element:<Editor/>},
        ]}],{initialEntries:[initial]});
        const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0},mutations:{retry:false}}});
        const root=createRoot(document.getElementById('root'));
        let version=0;
        const render=()=>root.render(<QueryClientProvider client={client}><RouterProvider router={router} key="router"/><span hidden>{version++}</span></QueryClientProvider>);
        const flush=async fn=>{await act(async()=>{fn?.();await new Promise(resolve=>setTimeout(resolve,20))});await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))})};
        await flush(render);
        return {
          requests,messages,router,flush,
          get saveCount(){return saveCount},
          get pathname(){return router.state.location.pathname},
          get dialog(){return document.querySelector('[role="dialog"]')},
          get sidebar(){return document.querySelector('.mac-secondary')},
          edit:async patch=>flush(()=>setGuard(current=>({...current,...patch}))),
          failSave:()=>{failSave=true},
          go:async to=>flush(()=>{void router.navigate(to)}),
          click:async text=>{const button=[...document.querySelectorAll('button')].find(item=>item.textContent===text);if(!button)throw Error('Missing button '+text);await flush(()=>{button.click()})},
          close:async()=>flush(()=>window.dispatchEvent(new window.CustomEvent('ai-novel-mac',{detail:{protocolVersion:1,type:'requestClose',requestId:'close-test'}}))),
          cleanup:async()=>{await flush(()=>{root.unmount();router.dispose()});client.clear();delete window.__AI_NOVEL_MAC__},
        };
      }
    ` },
    bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic',
    alias: { '@': path.resolve(macRoot, '../client/src') },
    define: { 'import.meta.env': '{}' }, outfile: output, logLevel: 'silent',
    plugins: [{ name: 'isolated-ui', setup(build) {
      build.onResolve({ filter: /^@\/components\/ui\/(dialog|button|toast)$/ }, (args) => ({ path: args.path, namespace: 'test-ui' }));
      build.onLoad({ filter: /.*/, namespace: 'test-ui' }, () => ({ resolveDir: macRoot, loader: 'tsx', contents: `
        import React from 'react';
        export const Dialog=({open,children})=>open?<div role="dialog">{children}</div>:null;
        export const DialogContent=({children})=><div>{children}</div>;
        export const DialogTitle=({children})=><h2>{children}</h2>;
        export const DialogDescription=({children})=><p>{children}</p>;
        export const Button=({variant,children,...props})=><button {...props}>{children}</button>;
        export const toast={info:()=>{},error:()=>{}};
      ` }));
    } }],
  });
  ({ mount } = await import(pathToFileURL(output).href));
});

after(() => {
  if (fs.existsSync(output)) fs.unlinkSync(output);
  dom?.window.close();
  restore.reverse().forEach((fn) => fn());
});

test('clean navigation and native close do not ask for a route-level manual review', async () => {
  const h = await mount();
  try {
    for (const route of ['/genres', '/settings/models', '/novels/create/', '/help']) {
      await h.go(route);
      assert.equal(h.pathname, route);
      assert.equal(h.dialog, null);
      if (route === '/novels/create/') assert.equal(h.sidebar.getAttribute('aria-label'), '开始创作');
    }
    await h.close();
    assert.equal(h.messages.at(-1)?.decision, 'allow');
    assert.equal(h.dialog, null);
  } finally { await h.cleanup(); }
});

test('dirty content can cancel, then save and navigate once without a second confirmation', async () => {
  const h = await mount();
  try {
    await h.edit({ dirty: true });
    await h.go('/novels');
    assert.equal(h.pathname, '/settings/models');
    assert.match(h.dialog.textContent, /测试正文/);
    await h.click('取消');
    assert.equal(h.dialog, null);
    await h.go('/novels');
    await h.click('保存并离开');
    assert.equal(h.saveCount, 1);
    assert.equal(h.pathname, '/novels');
    assert.equal(h.dialog, null);
    await h.go('/settings');
    assert.equal(h.pathname, '/settings');
  } finally { await h.cleanup(); }
});

test('failed saves and busy work preserve the page; explicit discard permits leaving', async () => {
  const h = await mount();
  try {
    await h.edit({ busy: true });
    await h.close();
    assert.equal(h.messages.at(-1)?.decision, 'cancel');
    await h.edit({ dirty: true, busy: false });
    h.failSave();
    await h.go('/novels');
    await h.click('保存并离开');
    assert.equal(h.pathname, '/settings/models');
    assert.match(h.dialog.textContent, /测试保存失败/);
    await h.click('放弃未保存修改');
    assert.equal(h.pathname, '/novels');
    assert.equal(h.dialog, null);
  } finally { await h.cleanup(); }
});

test('sidebar follows each menu and does not retain the previous novel or chapter requests', async () => {
  const h = await mount('/novels/book-a/edit');
  try {
    assert.match(h.sidebar.textContent, /测试章节/);
    await h.edit({ dirty: false });
    await h.flush(() => h.sidebar.querySelector('.mac-current-book').click());
    assert.ok(!h.sidebar.textContent.includes('测试章节'));
    await h.flush(() => [...h.sidebar.querySelectorAll('a')].find((link) => link.textContent === '测试作品').click());
    assert.equal(h.pathname, '/novels/book-a/edit');
    assert.match(h.sidebar.textContent, /测试章节/);
    const chapterReads = h.requests.filter(({url}) => url.endsWith('/chapters')).length;
    for (const [route, title, content] of [
      ['/novels', '我的小说', '测试作品'], ['/create', '开始创作', '填写小说设定'],
      ['/creative-hub', '创作对话', '构思对话'], ['/lab/director', '导演创作', '测试创作记录'],
      ['/tasks', '记录筛选', '进行中'], ['/settings/models', '设置分类', '模型路由'],
      ['/drama', '短剧项目', '短剧项目甲'], ['/comic', '漫画项目', '漫画项目甲'],
      ['/knowledge', '资料与参考', '书籍分析'], ['/genres', '故事素材', '角色素材'],
      ['/prompt-workbench', '写作工具', '写作规则'], ['/help', '创作指南', '创作路线'],
    ]) {
      await h.go(route);
      assert.equal(h.sidebar.getAttribute('aria-label'), title);
      assert.ok(h.sidebar.textContent.includes(content), route);
      assert.ok(!h.sidebar.textContent.includes('测试章节'), route);
    }
    assert.equal(h.requests.filter(({url}) => url.endsWith('/chapters')).length, chapterReads);
    assert.ok(h.requests.every(({method}) => method === 'get'));
  } finally { await h.cleanup(); }
});

test('record sidebar status controls the page and read-only API, including back navigation', async () => {
  const h = await mount('/tasks');
  try {
    await h.go('/tasks?status=failed');
    assert.equal(document.querySelector('select[aria-label="记录状态"]').value, 'failed');
    assert.equal(h.requests.filter(({url}) => url === '/tasks').at(-1).params.status, 'failed');
    assert.equal(h.sidebar.querySelector('[aria-current="page"]').textContent, '未完成');
    await h.go(-1);
    assert.equal(document.querySelector('select[aria-label="记录状态"]').value, '');
    assert.equal(h.sidebar.querySelector('[aria-current="page"]').textContent, '全部状态');
    assert.ok(h.requests.every(({method}) => method === 'get'));
  } finally { await h.cleanup(); }
});

test('chapter sidebar can expand, and cancelling navigation retains its chapter context', async () => {
  const h = await mount('/novels/book-a/chapters/chapter-a');
  try {
    assert.equal(h.sidebar.getAttribute('aria-hidden'), 'true');
    await h.flush(() => document.querySelector('.mac-drawer-toggle').click());
    assert.equal(h.sidebar.getAttribute('aria-hidden'), 'false');
    assert.equal(h.sidebar.querySelector('[aria-current="page"]').textContent, '1测试章节');
    await h.edit({ dirty: true });
    await h.go('/settings');
    await h.click('取消');
    assert.equal(h.pathname, '/novels/book-a/chapters/chapter-a');
    assert.equal(h.sidebar.getAttribute('aria-label'), '小说与章节');
    assert.match(h.sidebar.textContent, /测试章节/);
  } finally { await h.cleanup(); }
});
