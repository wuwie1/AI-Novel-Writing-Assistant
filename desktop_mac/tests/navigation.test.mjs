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
    ...Object.fromEntries(['Node', 'Element', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'FormData', 'getComputedStyle'].map((key) => [key, typeof dom.window[key] === 'function' && key === 'getComputedStyle' ? dom.window[key].bind(dom.window) : dom.window[key]])),
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
      import DirectorRunHistoryPage from '@/pages/directorNext/DirectorRunHistoryPage';
      import CreativeHubThreadList from '@/pages/creativeHub/components/CreativeHubThreadList';
      import NovelPreview from '@/pages/novels/NovelPreview';
      import NovelChapterEdit from '@/pages/novels/NovelChapterEdit';
      import MacNovelShelf from './renderer/src/features/novels/MacNovelShelf';
      import MacTaskRecords from './renderer/src/features/tasks/MacTaskRecords';
      import {EntityList,useDocumentGuard} from '@/platform';
      import {apiClient} from '@/api/client';
      export async function mount(initial='/settings/models') {
        const requests=[],messages=[];
        window.__AI_NOVEL_MAC__={protocolVersion:1,mode:'local',backendIdentity:'test',postMessage:message=>messages.push(message)};
        const novel={id:'book-a',title:'测试作品',narrativeForm:'long_novel',updatedAt:'2026-01-01',_count:{chapters:1,characters:0},chapters:[{id:'chapter-a',title:'测试章节',order:1,content:'原文甲'},{id:'chapter-b',title:'次章',order:2,content:'原文乙'}],characters:[]};
        apiClient.defaults.adapter=async config=>{
          requests.push({url:config.url,method:config.method,params:config.params});
          let data;
          if(config.url==='/novels') data={items:config.params.search==='无结果'?[]:[config.params.page===2?{...novel,id:'book-b',title:'第二页作品'}:novel],total:25,totalPages:2};
          else if(config.url==='/novels/offpage') data={...novel,id:'offpage',workspaceSourceRoute:'/lab/director/offpage'};
          else if(config.url.includes('editor-workspace')) data={};
          else if(config.url==='/novels/book-b') data={...novel,id:'book-b',chapters:[{id:'different',title:'另一作品',order:1,content:'另一正文'}]};
          else if(config.url==='/novels/book-a') data=novel;
          else if(config.url==='/novels/book-a/chapters') data=[{id:'chapter-a',title:'测试章节',order:1}];
          else if(config.url==='/creative-hub/threads') data=[{id:'thread-a',title:'构思对话'}];
          else if(config.url==='/director-next/legacy-records') data=[{runId:'old',headline:'旧版记录',sourceRoute:'/novels/book-a/edit'}];
          else if(config.url==='/director-next/records') data=[{runId:'run-b',headline:'第二次运行',directorRoute:'/lab/director/book-a'},{runId:'run-a',headline:'测试创作记录',statusLabel:'完成',progressLabel:'1章',directorRoute:'/lab/director/book-a'}];
          else if(config.url==='/drama/projects' || config.url==='/comic/projects') data=[{id:'project-a',title:config.url.startsWith('/drama')?'短剧项目甲':'漫画项目甲'}];
          else if(config.url==='/tasks') data={items:config.params.keyword==='无结果'?[]:['novel_pipeline','agent_run'].map((kind,i)=>({id:'same',kind,title:i?'记录乙':'记录甲',status:'succeeded',progress:100})),nextCursor:config.params.cursor?null:'older'};
          else if(config.url.startsWith('/tasks/')) data=config.url.endsWith('/gone')?null:{id:config.url.split('/').pop(),kind:config.url.split('/')[2],title:'详情 '+config.url.split('/').slice(-2).join('/'),ownerLabel:'测试作品',status:'succeeded',steps:[]};
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
        function Threads() {
          const [id,select]=React.useState('one'), [busy,setBusy]=React.useState(false);
          const rows=['one','two'].map((id,i)=>({id,title:i?'第二会话':'构思对话',resourceBindings:{},status:'idle'}));
          return <><EntityList collection="creative-threads" title="创作对话" selection={id}><CreativeHubThreadList threads={rows} activeThreadId={id} onSelect={select} actionDisabled={busy}/></EntityList><button onClick={()=>setBusy(true)}>测试忙碌</button></>;
        }
        const router=createMemoryRouter([{element:<MacDocumentProtection><MacAppLayout/></MacDocumentProtection>,children:[
          {path:'fixture',element:<><EntityList collection="fixture" title="测试目录" selection={null}><button>记录甲</button><button>记录乙</button></EntityList><Editor/></>},
          {path:'creative-hub',element:<Threads/>},{path:'lab/director',element:<DirectorRunHistoryPage/>},{path:'novels/:id/preview',element:<NovelPreview/>},{path:'novels/:id/chapters/:chapterId',element:<><Editor/><NovelChapterEdit/></>},{path:'novels',element:<MacNovelShelf/>},{path:'tasks',element:<MacTaskRecords/>},{path:'*',element:<Editor/>},
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
          search:async value=>flush(()=>{
            const input=document.querySelector('.mac-secondary input[type=search]');
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,value);
            input.dispatchEvent(new window.Event('input',{bubbles:true}));
          }),
          click:async text=>{const button=[...document.querySelectorAll('button')].find(item=>item.textContent===text);if(!button)throw Error('Missing button '+text);await flush(()=>{button.click()})},
          close:async()=>flush(()=>window.dispatchEvent(new window.CustomEvent('ai-novel-mac',{detail:{protocolVersion:1,type:'requestClose',requestId:'close-test'}}))),
          cleanup:async()=>{await flush(()=>{root.unmount();router.dispose()});client.clear();delete window.__AI_NOVEL_MAC__},
        };
      }
    ` },
    bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic',
    loader: { '.webp':'dataurl', '.css':'empty' },
    alias: { '@': path.resolve(macRoot, '../client/src') },
    define: { 'import.meta.env': '{}' }, outfile: output, logLevel: 'silent',
    plugins: [{ name: 'isolated-ui', setup(build) {
      build.onResolve({filter:/\/ChapterEditorShell$/}, () => ({path:'plate',namespace:'test-editor'}));
      build.onLoad({filter:/.*/,namespace:'test-editor'}, () => ({resolveDir:macRoot,loader:'tsx',contents:'export default function Shell({chapter}){return <textarea aria-label="正文" defaultValue={chapter.content}/> }'}));
      build.onResolve({filter:/^@\/components\/layout\/TaskRecoveryContext$/}, () => ({path:'recovery',namespace:'test-recovery'}));
      build.onLoad({filter:/.*/,namespace:'test-recovery'}, () => ({contents:'export function useTaskRecovery(){return {candidateCount:0,openDialog(){}}}'}));
      build.onResolve({ filter: /^@\/components\/common\/LLMSelector$/ }, (args) => ({ path: args.path, namespace: 'test-llm' }));
      build.onLoad({ filter: /.*/, namespace: 'test-llm' }, () => ({ resolveDir: macRoot, loader: 'tsx', contents: 'export default function LLMSelector(){return null;}' }));
      build.onResolve({ filter: /^@\/components\/ui\/(dialog|button|toast)$/ }, (args) => ({ path: args.path, namespace: 'test-ui' }));
      build.onLoad({ filter: /.*/, namespace: 'test-ui' }, () => ({ resolveDir: macRoot, loader: 'tsx', contents: `
        import React from 'react';
        export const Dialog=({open,children})=>open?<div role="dialog">{children}</div>:null;
        const Pass=({children})=><div>{children}</div>;
        export const DialogContent=Pass, AppDialogContent=Pass, DialogHeader=Pass, DialogFooter=Pass, DialogPortal=Pass, DialogOverlay=()=>null, DialogTrigger=Pass, DialogClose=Pass;
        export const DialogTitle=({children})=><h2>{children}</h2>;
        export const DialogDescription=({children})=><p>{children}</p>;
        export const Button=({variant,size,asChild,children,...props})=><button {...props}>{children}</button>;
        const noop=()=>{};
        export const toast=Object.assign(noop,{info:noop,error:noop,success:noop,warning:noop,dismiss:noop});
        export const Toaster=()=>null;
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
      if (route === '/novels/create/') assert.ok(h.sidebar.hidden);
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

test('an occluded window answers close without animation frames and brings only a dirty prompt forward', async () => {
  const h = await mount();
  const previous = globalThis.requestAnimationFrame;
  // WebKit may suspend all frames while occluded.
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 0 });
  try {
    await h.close();
    assert.deepEqual(h.messages.map((message) => message.type), ['closeDecision']);
    assert.equal(h.messages.at(-1).decision, 'allow');
    await h.edit({ dirty: true });
    await h.close();
    assert.equal(h.messages.at(-1).type, 'closeNeedsAttention');
    assert.equal(h.messages.at(-1).requestId, 'close-test');
    await h.flush(() => window.dispatchEvent(new window.CustomEvent('ai-novel-mac', {
      detail: { protocolVersion: 1, type: 'closeExpired', requestId: 'close-test' },
    })));
    assert.equal(h.dialog, null);
    assert.equal(h.messages.at(-1).decision, 'cancel');
    await h.close();
    await h.click('保存并离开');
    assert.equal(h.saveCount, 1);
    assert.equal(h.messages.at(-1).decision, 'allow');
  } finally {
    Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: previous });
    await h.cleanup();
  }
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
  const h = await mount('/novels/book-a/preview');
  try {
    assert.match(h.sidebar.textContent, /测试章节/);
    const chapterReads = h.requests.filter(({url}) => url.endsWith('/chapters')).length;
    for (const [route, title, content] of [
      ['/novels', '我的小说', '测试作品'],
      ['/creative-hub', '创作对话', '构思对话'], ['/lab/director', '导演运行记录', '测试创作记录'],
      ['/tasks', '运行记录', '记录甲'], ['/settings/models', '设置分类', '模型路由'],
      ['/drama', '更多功能', '视觉资源库'], ['/comic', '漫画项目', '漫画项目甲'],
      ['/knowledge', '资料与参考', '书籍分析'], ['/genres', '故事素材', '角色素材'],
      ['/prompt-workbench', '写作工具', '写作规则'],
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

test('director history distinguishes runs in one book and from legacy records; busy threads keep selection', async () => {
  const h = await mount('/lab/director');
  try {
    await h.flush(() => h.sidebar.querySelectorAll('.mac-list-row')[1].click());
    assert.match(h.router.state.location.search,/runId=run-a/);
    await h.flush(() => h.sidebar.querySelectorAll('.mac-list-row')[2].click());
    assert.equal(document.querySelector('main a[href="/novels/book-a/edit"]').textContent,'打开小说');
    await h.go(-1);
    assert.ok(document.querySelector('main a[href="/lab/director/book-a"]'));
    await h.go('/creative-hub');
    await h.click('测试忙碌');
    assert.ok(h.sidebar.querySelector('button[aria-current]').disabled);
    assert.ok(h.requests.every(r=>r.method==='get'));
  } finally {await h.cleanup();}
});

test('record sidebar status controls the page and read-only API, including back navigation', async () => {
  const h = await mount('/tasks');
  try {
    await h.go('/tasks?status=failed');
    assert.equal(document.querySelector('select[aria-label="记录状态"]').value, 'failed');
    assert.equal(h.requests.filter(({url}) => url === '/tasks').at(-1).params.status, 'failed');
    assert.ok(h.sidebar.querySelector('select[aria-label="记录类型"]'));
    await h.go(-1);
    assert.equal(document.querySelector('select[aria-label="记录状态"]').value, '');
    assert.equal(h.sidebar.querySelector('[aria-current]'), null);
    assert.ok(h.requests.every(({method}) => method === 'get'));
  } finally { await h.cleanup(); }
});

test('chapter sidebar can expand, and cancelling navigation retains its chapter context', async () => {
  const h = await mount('/novels/book-a/chapters/chapter-a');
  try {
    assert.equal(h.sidebar.getAttribute('aria-hidden'), 'false');
    assert.match(h.sidebar.querySelector('[aria-current]').textContent,/测试章节/);
    await h.edit({ dirty: true });
    await h.flush(() => h.sidebar.querySelectorAll('.mac-list-row')[1].click());
    await h.click('取消');
    assert.equal(h.pathname, '/novels/book-a/chapters/chapter-a');
    assert.equal(h.sidebar.getAttribute('aria-label'), '章节目录');
    assert.match(h.sidebar.textContent, /测试章节/);
  } finally { await h.cleanup(); }
});

test('context search filters loaded rows, keeps selection and resets when changing menus', async () => {
  const h = await mount('/novels');
  try {
    await h.go('/settings/models');
    assert.equal(h.sidebar.querySelector('input').value, '');
    await h.search('模型');
    assert.ok(h.sidebar.querySelectorAll('a').length > 0);
    assert.ok([...h.sidebar.querySelectorAll('a')].every(link => link.textContent.includes('模型')));
    assert.ok(h.sidebar.querySelector('[aria-current="page"]'));
    await h.go('/novels/book-a/chapters/chapter-a');
    await h.search('1');
    assert.match(h.sidebar.textContent, /测试章节/);
    await h.search('2');
    assert.ok(!h.sidebar.textContent.includes('测试章节'));
    assert.equal(h.dialog, null);
    assert.ok(h.requests.every(({method}) => method === 'get'));
  } finally { await h.cleanup(); }
});

test('one page owns its portal across drawer toggles and help has a full canvas', async () => {
  const media = window.matchMedia;
  window.matchMedia = () => ({matches:true, addEventListener(){}, removeEventListener(){}});
  const h = await mount('/fixture');
  try {
    const first = h.sidebar.querySelector('.mac-context-list button');
    assert.equal(first.textContent, '记录甲');
    assert.equal(h.sidebar.getAttribute('aria-hidden'), 'false');
    await h.flush(() => window.dispatchEvent(new window.KeyboardEvent('keydown', {key:'Escape'})));
    assert.equal(h.sidebar.getAttribute('aria-hidden'), 'true');
    assert.equal(document.activeElement, document.querySelector('.mac-drawer-toggle'));
    await h.flush(() => document.activeElement.click());
    assert.equal(h.sidebar.querySelector('.mac-context-list button'), first);
    await h.go('/help');
    assert.ok(h.sidebar.hidden && h.sidebar.hasAttribute('inert'));
    assert.equal(document.querySelector('.mac-drawer-toggle'), null);
  } finally { await h.cleanup(); window.matchMedia = media; }
});

test('task detail identity, filters, cursor, unavailable records and back are independent', async () => {
  const h = await mount('/tasks?filterKind=agent_run&kind=agent_run&id=offpage&cursor=older');
  try {
    assert.match(document.querySelector('.mac-record-detail').textContent, /agent_run\/offpage/);
    const select = async (i) => h.flush(() => h.sidebar.querySelectorAll('.mac-record-list button')[i].click());
    await select(0); await select(1);
    assert.match(document.querySelector('.mac-record-detail').textContent, /agent_run\/same/);
    await h.go(-1);
    assert.match(document.querySelector('.mac-record-detail').textContent, /novel_pipeline\/same/);
    assert.match(h.router.state.location.search, /cursor=older/);
    await h.flush(() => document.querySelector('[aria-label="刷新记录"]').click());
    assert.equal(h.sidebar.querySelector('[aria-current]').querySelector('strong').textContent,'记录甲');
    await h.go('/tasks?kind=agent_run&id=gone&q=无结果');
    assert.match(document.querySelector('.mac-record-detail').textContent, /找不到/);
    assert.match(h.sidebar.textContent, /没有符合/);
    await h.go('/tasks?kind=bad&id=x');
    assert.equal(h.router.state.location.search, '');
    assert.ok(!h.requests.some(r => r.url.includes('/bad/')));
    assert.ok(h.requests.every(r => r.method === 'get'));
  } finally { await h.cleanup(); }
});

test('shelf restores page two, opens off-page metadata and keeps overview explicit', async () => {
  const h = await mount('/novels?page=2&q=山');
  try {
    assert.match(h.sidebar.textContent, /第二页作品/);
    assert.equal(h.requests.filter(r=>r.url==='/novels')[0].params.page,2);
    assert.match(document.querySelector('.mac-book-summary').textContent,/第二页作品/);
    await h.go('/novels?selectedNovelId=offpage');
    await h.click('继续写作');
    assert.equal(h.pathname,'/lab/director/offpage');
    await h.go(-1);
    assert.match(h.router.state.location.search,/offpage/);
    await h.go('/novels?view=shelf');
    assert.ok(h.sidebar.hidden);
    await h.go('/novels?layout=detail&view=workbench&q=无结果');
    assert.match(h.sidebar.textContent,/没有符合条件的小说/);
    assert.ok(!h.requests.some(r=>r.params?.limit===100));
  } finally { await h.cleanup(); }
});

test('preview switches text and retains directory search only within the same book', async () => {
  const h = await mount('/novels/book-a/preview');
  try {
    await h.search('章');
    await h.flush(() => h.sidebar.querySelectorAll('.mac-list-row')[1].click());
    assert.equal(h.pathname, '/novels/book-a/preview');
    assert.match(document.querySelector('article').textContent,/原文乙/);
    assert.equal(h.sidebar.querySelector('input').value,'章');
    await h.go('/novels/book-b/preview');
    assert.equal(h.sidebar.querySelector('input').value,'');
    assert.match(h.sidebar.textContent,/另一作品/);
    assert.ok(!h.sidebar.textContent.includes('测试章节'));
  } finally {await h.cleanup();}
});
