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
    cancelAnimationFrame: clearTimeout,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    ...Object.fromEntries(['Node', 'DocumentFragment', 'MutationObserver', 'Element', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'FormData', 'getComputedStyle'].map((key) => [key, typeof dom.window[key] === 'function' && key === 'getComputedStyle' ? dom.window[key].bind(dom.window) : dom.window[key]])),
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
      import ComicWorkspacePage from '@/pages/comic/ComicWorkspacePage';
      import ComicProjectPage from '@/pages/comic/ComicProjectPage';
      import DramaWorkspacePage from '@/pages/drama/DramaWorkspacePage';
      import SettingsPage from '@/pages/settings/SettingsPage';
      import ModelRoutesPage from '@/pages/settings/ModelRoutesPage';
      import GenreManagementPage from '@/pages/genres/GenreManagementPage';
      import KnowledgePage from '@/pages/knowledge/KnowledgePage';
      import ShortStoryStudioPage from '@/pages/shortStory/ShortStoryStudioPage';
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
        let releaseDocument,failDocument=true;
        const docs=['a','b'].map(id=>({id,title:'资料'+id,status:'enabled',activeVersionId:id+'2',activeVersionNumber:2,versions:[1,2].map(n=>({id:id+n,versionNumber:n,content:'文档版本 '+id+n,createdAt:'2026-01-01'}))}));
        apiClient.defaults.adapter=async config=>{
          requests.push({url:config.url,method:config.method,params:config.params});
          let data;
          if(config.url==='/novels') data={items:config.params.search==='无结果'?[]:[config.params.page===2?{...novel,id:'book-b',title:'第二页作品'}:novel],total:25,totalPages:2};
          else if(config.url==='/novels/offpage') data={...novel,id:'offpage',workspaceSourceRoute:'/lab/director/offpage'};
          else if(config.url.includes('editor-workspace')) data={};
          else if(config.url==='/novels/book-b') data={...novel,id:'book-b',chapters:[{id:'different',title:'另一作品',order:1,content:'另一正文'}]};
          else if(config.url==='/novels/book-a/short-story') data={novel,production:{status:'completed'},continuousContent:'第一段和第二段',segments:[{id:'s1',content:'第一段',version:1},{id:'s2',content:'第二段',version:1}]};
          else if(config.url==='/novels/book-a') data=novel;
          else if(config.url==='/novels/book-a/chapters') data=[{id:'chapter-a',title:'测试章节',order:1}];
          else if(config.url==='/settings/api-keys') data=[{provider:'deepseek',kind:'builtin',name:'测试厂商',models:['test'],defaultModel:'test',isActive:false,isConfigured:false}];
          else if(config.url==='/settings/api-keys/balances') data=[];
          else if(config.url==='/llm/structured-fallback') data=null;
          else if(config.url==='/llm/model-routes/connectivity') data={statuses:[]};
          else if(config.url==='/llm/model-routes' && config.method==='put') throw Error('模拟保存失败');
          else if(config.url==='/llm/model-routes') data={taskTypes:['writer','planner'],routes:['writer','planner'].map(taskType=>({taskType,provider:'deepseek',model:'test',temperature:0.7,maxTokens:null,requestProtocol:'auto',structuredResponseFormat:'auto'}))};
          else if(config.url==='/comic/projects/project-a') data={id:'project-a',title:'漫画详情',characters:[],sourceType:'novel_import'};
          else if(config.url==='/comic/projects/project-a/episodes') data=[{id:'episode',title:'第一话大纲',order:1}];
          else if(config.url==='/genres') data=['one','two'].map((id,i)=>({id,name:'同名题材',description:i?'定位乙':'定位甲',children:[],novelCount:0,childCount:0}));
          else if(config.url==='/knowledge/documents') data=docs;
          else if(config.url==='/rag/jobs') data=[];
          else if(config.url==='/knowledge/documents/a') {await new Promise(resolve=>{releaseDocument=resolve});data=docs[0];}
          else if(config.url==='/knowledge/documents/b') {if(failDocument){failDocument=false;throw Error('读取失败')} data=docs[1];}
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
          {path:'settings/models',element:<><Editor/><SettingsPage/></>},{path:'settings/model-routes',element:<ModelRoutesPage/>},
          {path:'comic',element:<ComicWorkspacePage/>},{path:'comic/projects/:id',element:<ComicProjectPage/>},{path:'drama',element:<DramaWorkspacePage/>},{path:'genres',element:<GenreManagementPage/>},{path:'knowledge',element:<KnowledgePage/>},{path:'creative-hub',element:<Threads/>},{path:'lab/director',element:<DirectorRunHistoryPage/>},{path:'novels/:id/story',element:<ShortStoryStudioPage/>},{path:'novels/:id/preview',element:<NovelPreview/>},{path:'novels/:id/chapters/:chapterId',element:<><Editor/><NovelChapterEdit/></>},{path:'novels',element:<MacNovelShelf/>},{path:'tasks',element:<MacTaskRecords/>},{path:'*',element:<Editor/>},
        ]}],{initialEntries:[initial]});
        const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0},mutations:{retry:false,gcTime:0}}});
        const root=createRoot(document.getElementById('root'));
        let version=0;
        const render=()=>root.render(<QueryClientProvider client={client}><RouterProvider router={router} key="router"/><span hidden>{version++}</span></QueryClientProvider>);
        const flush=async fn=>{await act(async()=>{fn?.();await new Promise(resolve=>setTimeout(resolve,20))});await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))})};
        await flush(render);
        return {
          requests,messages,router,flush,releaseDocument:()=>releaseDocument(),
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
        export const Dialog=({open,children,onOpenChange})=>open?<div role="dialog">{children}{onOpenChange && <button aria-label="关闭测试浮层" onClick={()=>onOpenChange(false)}>关闭浮层</button>}</div>:null;
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
    await h.close();
    assert.equal(h.messages.at(-1)?.reason, 'close_pending');
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
    assert.deepEqual(h.messages.map(message => message.type), ['rendererReady']);
    await h.flush(() => window.dispatchEvent(new window.Event('pageshow')));
    await h.close();
    assert.deepEqual(h.messages.map(message => message.type), ['rendererReady', 'rendererReady', 'closeDecision']);
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
    assert.equal(h.messages.at(-1)?.reason, 'document_busy');
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
      ['/tasks', '运行记录', '记录甲'], ['/settings/models', '模型厂商', '测试厂商'],
      ['/drama', '短剧项目', '短剧项目甲'], ['/comic', '漫画项目', '漫画项目甲'],
      ['/knowledge', '创作资料', '资料b'], ['/genres', '题材目录', '同名题材'],
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
    const editor = document.querySelector('textarea[aria-label="正文"]');
    editor.value = '待保存的正文';
    editor.focus();
    const next = h.sidebar.querySelectorAll('.mac-list-row')[1];
    await h.flush(() => {
      next.dispatchEvent(new window.Event('pointerdown', {bubbles: true}));
      next.focus();
      next.click();
    });
    await h.click('取消');
    assert.equal(document.activeElement, editor);
    assert.equal(editor.value, '待保存的正文');
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
    await h.search('测试');
    assert.ok(h.sidebar.querySelector('button[aria-current]')?.textContent.includes('测试厂商'));
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

test('knowledge keeps the selected historical version after retry and a late previous document', async () => {
  const h = await mount('/knowledge?documentId=a');
  try {
    await h.go('/knowledge?documentId=b&versionId=b1');
    assert.match(document.querySelector('main').textContent, /无法读取这份文档/);
    await h.click('重新读取');
    assert.match(document.querySelector('main').textContent, /文档版本 b1/);
    const href = document.querySelector('main a[href*="versionId=b1"]').getAttribute('href');
    assert.match(href, /documentId=b/);
    await h.flush(h.releaseDocument);
    assert.doesNotMatch(document.querySelector('main').textContent, /文档版本 a/);
    assert.ok(h.requests.every(request => request.method === 'get'));
  } finally { await h.cleanup(); }
});

test('same-name tree nodes stay distinct across consecutive selections, tool switches and history', async () => {
  const h = await mount('/genres?selectedId=one');
  try {
    const detail = () => document.getElementById('selected-genre-title').parentElement.textContent;
    assert.match(detail(), /定位甲/);
    await h.flush(() => h.sidebar.querySelectorAll('.mac-list-row')[1].click());
    assert.match(detail(), /定位乙/);
    assert.match(h.router.state.location.search, /selectedId=two/);
    await h.go('/titles');
    assert.ok(h.sidebar.hidden);
    await h.go(-1);
    assert.match(detail(), /定位乙/);
    await h.go(-1);
    assert.match(detail(), /定位甲/);
  } finally { await h.cleanup(); }
});

test('comic project deep link reads only the comic project and its own episodes', async () => {
  const h = await mount('/comic/projects/project-a?tab=outline&itemId=episode');
  try {
    assert.match(h.sidebar.textContent, /第一话大纲/);
    assert.match(document.querySelector('main').textContent, /漫画详情/);
    assert.equal(h.requests.filter(r => r.url.endsWith('/episodes')).length, 1);
    assert.ok(!h.requests.some(r => r.url.startsWith('/drama') || r.url === '/comic/projects'));
  } finally { await h.cleanup(); }
});

test('selecting a model route offers cancellation and retains the draft after a failed save', async () => {
  const h = await mount('/settings/model-routes?taskType=writer');
  try {
    const input = [...document.querySelectorAll('input[placeholder="也可以手动输入模型名"]')].at(-1);
    assert.ok(input);
    await h.flush(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'draft-model');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const next = () => h.sidebar.querySelectorAll('.mac-list-row')[1].click();
    await h.flush(next);
    assert.match(h.dialog.textContent, /模型路由设置/);
    await h.click('取消');
    assert.equal(input.value, 'draft-model');
    await h.flush(next);
    await h.click('保存并离开');
    assert.ok(h.dialog.querySelector('[role="alert"]'));
    assert.equal(input.value, 'draft-model');
    assert.match(h.router.state.location.search, /taskType=writer/);
    await h.click('放弃未保存修改');
    assert.match(h.router.state.location.search, /taskType=planner/);
  } finally { await h.cleanup(); }
});

test('closing the visual asset library keeps the current book selection and its filters', async () => {
  const location = '/novels?page=2&selectedNovelId=book-b';
  const h = await mount(location + '#visual-assets');
  try {
    assert.ok(h.dialog);
    assert.match(h.sidebar.querySelector('[aria-current]').textContent, /第二页作品/);
    await h.click('关闭浮层');
    assert.equal(h.dialog, null);
    assert.equal(h.router.state.location.hash, '');
    assert.equal(h.pathname + h.router.state.location.search, location);
    assert.match(h.sidebar.querySelector('[aria-current]').textContent, /第二页作品/);
  } finally { await h.cleanup(); }
});

test('short story segment history restores each draft within the same document', async () => {
  const h = await mount('/novels/book-a/story#segment=s2');
  const editor = () => document.querySelector('textarea[aria-label="作品正文"]');
  try {
    assert.equal(editor().value, '第二段');
    await h.flush(() => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(editor(), '保留的分段草稿');
      editor().dispatchEvent(new window.Event('input', {bubbles: true}));
    });
    await h.flush(() => h.sidebar.querySelector('.mac-list-row').click());
    assert.equal(h.dialog, null);
    assert.equal(h.router.state.location.hash, '#segment=s1');
    assert.equal(editor().value, '第一段');
    await h.go(-1);
    assert.equal(editor().value, '保留的分段草稿');
    await h.go('/help');
    assert.ok(h.dialog);
    await h.flush(() => [...h.dialog.querySelectorAll('button')].find(item => item.textContent === '取消').click());
    assert.equal(h.pathname, '/novels/book-a/story');
    assert.equal(editor().value, '保留的分段草稿');
  } finally { await h.cleanup(); }
});

test('collection filters return focus on Escape and overview tabs respond to arrow keys', async () => {
  const h = await mount('/novels');
  try {
    const filter = h.sidebar.querySelector('.mac-collection-filters');
    filter.open = true;
    const control = filter.querySelector('select');
    control.focus();
    await h.flush(() => control.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})));
    assert.equal(filter.open, false);
    assert.equal(document.activeElement, filter.querySelector('summary'));
    await h.click('书架总览');
    const tabs = document.querySelectorAll('[aria-label="书架视图"] [role="tab"]');
    tabs[0].focus();
    await h.flush(() => tabs[0].dispatchEvent(new window.KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true, cancelable: true})));
    assert.equal(document.activeElement, tabs[1]);
    assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
    assert.ok(h.sidebar.hidden);
  } finally { await h.cleanup(); }
});
