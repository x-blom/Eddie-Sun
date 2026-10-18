import * as assert from 'assert';
import * as vm from 'vm';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { SidebarProvider } from '../SidebarProvider';

type Listener = (event?: any) => void;

interface FakeElement {
  value: string;
  textContent: string;
  children: FakeElement[];
  className: string;
  style: Record<string, string>;
  listeners: Record<string, Listener[]>;
  addEventListener(type: string, listener: Listener): void;
  append(...items: FakeElement[]): void;
}

function fakeElement(): FakeElement {
  const element: FakeElement = {
    value: '',
    textContent: '',
    children: [],
    className: '',
    style: {},
    listeners: {},
    addEventListener(type, listener) {
      (element.listeners[type] ??= []).push(listener);
    },
    append(...items) {
      element.children.push(...items);
    }
  };
  // Assigning textContent = '' empties an element, as in a real DOM.
  let text = '';
  Object.defineProperty(element, 'textContent', {
    get: () => text,
    set: (value: string) => {
      text = value;
      if (value === '') {
        element.children = [];
      }
    }
  });
  return element;
}

// Run the sidebar's webview script against a minimal fake DOM.
function runWebviewScript(storedState?: unknown) {
  const provider = new SidebarProvider(vscode.Uri.file('/ext'));
  const html: string = provider['_getHtmlForWebview']({ cspSource: 'test' } as vscode.Webview);
  provider.dispose();
  const script = /<script nonce="[^"]*">([\s\S]*)<\/script>/.exec(html)![1];

  const elements: Record<string, FakeElement> = {
    commitHashesTextarea: fakeElement(),
    toggleHighlightButton: fakeElement(),
    highlightStatus: fakeElement(),
    legend: fakeElement()
  };
  elements.highlightStatus.textContent = 'OFF';

  const posted: any[] = [];
  const timers: (() => void)[] = [];
  let state: any = storedState;
  const windowListeners: Record<string, Listener[]> = {};
  const document = {
    activeElement: undefined as FakeElement | undefined,
    getElementById: (id: string) => elements[id],
    createElement: () => fakeElement()
  };
  const context = vm.createContext({
    document,
    window: {
      addEventListener: (type: string, listener: Listener) => (windowListeners[type] ??= []).push(listener)
    },
    acquireVsCodeApi: () => ({
      // Round-trip through JSON so objects from the vm context compare equal to local ones.
      postMessage: (message: unknown) => posted.push(JSON.parse(JSON.stringify(message))),
      getState: () => state,
      setState: (value: unknown) => { state = JSON.parse(JSON.stringify(value)); }
    }),
    setTimeout: (fn: () => void) => timers.push(fn),
    clearTimeout: (id: number) => { timers[id - 1] = () => undefined; }
  });
  vm.runInContext(script, context);

  return {
    elements,
    document,
    posted,
    getState: () => state,
    flushTimers: () => timers.splice(0).forEach(fn => fn()),
    type: (text: string) => {
      elements.commitHashesTextarea.value = text;
      elements.commitHashesTextarea.listeners.input.forEach(l => l());
    },
    click: () => elements.toggleHighlightButton.listeners.click.forEach(l => l()),
    receive: (data: unknown) => windowListeners.message.forEach(l => l({ data }))
  };
}

suite('Sidebar webview script', () => {
  test('runs without errors and asks the extension for its state', () => {
    const webview = runWebviewScript();
    assert.deepStrictEqual(webview.posted, [{ type: 'viewStateRestored' }]);
  });

  test('typing saves the hashes immediately, even with highlighting off', () => {
    const webview = runWebviewScript();
    webview.type('abc123\n\n  def456  \n');
    assert.deepStrictEqual(webview.getState(), { commitHashes: ['abc123', 'def456'], isHighlightingEnabled: false });
  });

  test('typing sends the hashes to the extension once typing pauses', () => {
    const webview = runWebviewScript();
    webview.posted.length = 0;
    webview.type('abc');
    webview.type('abc123');
    assert.deepStrictEqual(webview.posted, []);
    webview.flushTimers();
    assert.deepStrictEqual(webview.posted, [{ type: 'updateCommitHashes', value: ['abc123'] }]);
  });

  test('shows one swatch per hash', () => {
    const webview = runWebviewScript();
    webview.type('abc123\ndef456\nghi789');
    const items = webview.elements.legend.children;
    assert.strictEqual(items.length, 3);
    assert.strictEqual(items[1].children[1].textContent, 'def456');
    assert.match(items[0].children[0].style.backgroundColor, /^rgb\(\d+, \d+, \d+\)$/);
    webview.type('abc123');
    assert.strictEqual(webview.elements.legend.children.length, 1);
  });

  test('shows what the extension found for each hash', () => {
    const webview = runWebviewScript();
    webview.type('abc123\ndef456\nghi789\njkl012');
    webview.receive({
      type: 'commitStatus',
      value: [
        { hash: 'abc123', status: 'ok', lines: 12 },
        { hash: 'def456', status: 'ok', lines: 1 },
        { hash: 'ghi789', status: 'gone', lines: 0 },
        { hash: 'jkl012', status: 'unknown', lines: 0 }
      ]
    });
    const items = webview.elements.legend.children;
    const status = (i: number) => items[i].children[2].textContent;
    assert.deepStrictEqual([0, 1, 2, 3].map(status), ['12 lines', '1 line', 'no code left', 'not found']);
    assert.deepStrictEqual(items.map(item => item.className.includes('no-match')), [false, false, true, true]);
  });

  test('status is dropped for a hash that was edited', () => {
    const webview = runWebviewScript();
    webview.type('abc123');
    webview.receive({ type: 'commitStatus', value: [{ hash: 'abc123', status: 'gone', lines: 0 }] });
    webview.type('abc124');
    const [item] = webview.elements.legend.children;
    assert.strictEqual(item.children.length, 2);
    assert.ok(!item.className.includes('no-match'));
  });

  test('restores saved hashes and hands them to the extension', () => {
    const webview = runWebviewScript({ commitHashes: ['abc123', 'def456'], isHighlightingEnabled: true });
    assert.strictEqual(webview.elements.commitHashesTextarea.value, 'abc123\ndef456');
    assert.strictEqual(webview.elements.highlightStatus.textContent, 'ON');
    assert.strictEqual(webview.elements.legend.children.length, 2);
    assert.deepStrictEqual(webview.posted, [
      { type: 'updateCommitHashes', value: ['abc123', 'def456'] },
      { type: 'viewStateRestored' }
    ]);
  });

  test('clicking the button sends the hashes and toggles highlighting', () => {
    const webview = runWebviewScript();
    webview.type('abc123');
    webview.posted.length = 0;
    webview.click();
    assert.deepStrictEqual(webview.posted, [
      { type: 'updateCommitHashes', value: ['abc123'] },
      { type: 'toggleHighlighting', value: true }
    ]);
    assert.strictEqual(webview.elements.highlightStatus.textContent, 'ON');
    webview.click();
    assert.strictEqual(webview.elements.highlightStatus.textContent, 'OFF');
  });

  test('state from the extension fills the box but not while typing', () => {
    const webview = runWebviewScript();
    webview.receive({ type: 'restoreState', commitHashes: ['aaa'], isHighlightingEnabled: false });
    assert.strictEqual(webview.elements.commitHashesTextarea.value, 'aaa');

    webview.document.activeElement = webview.elements.commitHashesTextarea;
    webview.type('bbb');
    webview.receive({ type: 'restoreState', commitHashes: ['aaa'], isHighlightingEnabled: false });
    assert.strictEqual(webview.elements.commitHashesTextarea.value, 'bbb');
  });
});

suite('Sidebar in a real webview', function () {
  this.timeout(20000);

  test('the page script runs and talks to the extension', async () => {
    const provider = new SidebarProvider(vscode.Uri.file('/ext'));
    const panel = vscode.window.createWebviewPanel('eddieTest', 'Eddie test', vscode.ViewColumn.Beside, { enableScripts: true });
    try {
      const firstMessage = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('webview never sent a message; its script probably failed')), 15000);
        panel.webview.onDidReceiveMessage(message => {
          clearTimeout(timeout);
          resolve(message);
        });
      });
      panel.webview.html = provider['_getHtmlForWebview'](panel.webview);
      assert.deepStrictEqual(await firstMessage, { type: 'viewStateRestored' });
    } finally {
      panel.dispose();
      provider.dispose();
    }
  });
});

suite('Sidebar provider', function () {
  this.timeout(20000);

  test('reports which listed commits still have code, without highlighting on', async () => {
    const fixture = JSON.parse(fs.readFileSync(process.env.EDDIE_FIXTURE!, 'utf8'));
    const provider = new SidebarProvider(vscode.Uri.file('/ext'));
    const posted: any[] = [];
    let receive: (message: unknown) => void = () => undefined;
    provider.resolveWebviewView({
      webview: {
        options: {},
        html: '',
        cspSource: 'test',
        postMessage: (message: unknown) => { posted.push(message); return Promise.resolve(true); },
        onDidReceiveMessage: (listener: (message: unknown) => void) => { receive = listener; return { dispose() {} }; }
      }
    } as unknown as vscode.WebviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

    try {
      receive({ type: 'updateCommitHashes', value: [fixture.third, fixture.fourth, 'deadbeef'] });
      while (!posted.some(message => message.type === 'commitStatus')) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const status = posted.find(message => message.type === 'commitStatus');
      assert.deepStrictEqual(status.value.map((m: any) => m.status), ['gone', 'ok', 'unknown']);

      // A webview that is recreated asks for its state and gets the statuses again.
      posted.length = 0;
      receive({ type: 'viewStateRestored' });
      assert.ok(posted.some(message => message.type === 'commitStatus' && message.value.length === 3));
    } finally {
      provider.dispose();
    }
  });
});
