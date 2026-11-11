import './asset-path';
import '@excalidraw/excalidraw/index.css';
import './theme.css';

import React from 'react';
import { createRoot } from 'react-dom/client';
import { connectHost, type FileEditorChange, type FileEditorDocument, type HostReadyContext } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

import { CanvasEditor, type CanvasSession } from './CanvasEditor';

// OpenChamber keeps the file. It hands this page the text (`onFileOpen`),
// asks for the drawing when it saves or switches to the source view
// (`onFileSnapshot`), and says which snapshot reached the disk (`onFileSaved`).
// Saving, autosave, Cmd/Ctrl+S, and external changes are the host's.

const host = connectHost();

// The frame has no image clipboard. Excalidraw's "Copy as PNG" calls
// navigator.clipboard.write, so hand image/png blobs to the local service.
const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
// The host spawns the service on the first request, which can outlast its reply
// window. Wake it when the editor opens and retry requests that time out.
type ServiceCall = Parameters<typeof host.serviceRequest>[0];
const callService = async (request: ServiceCall) => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await host.serviceRequest(request);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw lastError;
};
void callService({ method: 'GET', path: '/health' }).catch(() => undefined);
const originalWrite = navigator.clipboard?.write?.bind(navigator.clipboard);
const patchedWrite = async (items: ClipboardItem[]): Promise<void> => {
  for (const item of items) {
    if (!item.types.includes('image/png')) continue;
    try {
      const data = await blobToBase64(await item.getType('image/png'));
      // Pieces stay small: the host's message channel times out on big bodies.
      const CHUNK = 24 * 1024;
      const total = Math.ceil(data.length / CHUNK);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      for (let index = 0; index < total; index += 1) {
        try {
          const result = await callService({ method: 'POST', path: '/copy-png', body: JSON.stringify({ id, index, total, data: data.slice(index * CHUNK, (index + 1) * CHUNK) }) });
          if (result.status >= 400) throw new Error(`status ${result.status}: ${result.body}`);
        } catch (chunkError) {
          throw new Error(`chunk ${index + 1}/${total} of ${Math.round(data.length / 1024)} KB: ${chunkError instanceof Error ? chunkError.message : String(chunkError)}`);
        }
      }
      await host.toast({ kind: 'success', message: 'Copied PNG to the clipboard' });
      return;
    } catch (error) {
      await host.toast({ kind: 'error', message: `Could not copy PNG: ${error instanceof Error ? error.message : String(error)}`, copy: true });
      throw error;
    }
  }
  if (originalWrite) await originalWrite(items);
};
try {
  Object.defineProperty(navigator.clipboard, 'write', { value: patchedWrite, configurable: true });
} catch {
  // read-only clipboard object: leave the default behaviour
}
const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

// The mounted canvas; the host's snapshot and saved calls go to it.
let session: CanvasSession | null = null;

host.onFileSnapshot(() => {
  if (!session) throw new Error('The drawing is not open yet.');
  return session.snapshot();
});
host.onFileSaved((version) => session?.markSaved(version));

// Stable identities, so the canvas does not re-register on every render.
const setSession = (next: CanvasSession | null): void => { session = next; };
const reportChange = (change: FileEditorChange): void => host.reportFileChange(change);
const reportUnsupported = (): void => host.reportFileUnsupported();

// Path of the SVG written next to the drawing: `a/b.excalidraw` -> `a/b.svg`.
const svgPathFor = (path: string): string => path.replace(/\.excalidraw(\.md)?$/, '') + '.svg';

type State = { context: HostReadyContext | null; file: FileEditorDocument | null; opened: number };

const App: React.FC = () => {
  const [state, setState] = React.useState<State>({ context: null, file: null, opened: 0 });

  React.useEffect(() => {
    const offReady = host.onReady((context) => {
      applyHostReady(context, document.documentElement);
      setState((current) => ({ ...current, context }));
    });
    // Every file the host hands over is a fresh document: the host only sends
    // a different one after a reload it decided on (external change, discard).
    const offFile = host.onFileOpen((file) => setState((current) => ({ ...current, file, opened: current.opened + 1 })));
    return () => {
      offReady();
      offFile();
    };
  }, []);

  if (!state.context || !state.file) return null;
  return (
    <CanvasEditor
      key={state.opened}
      file={state.file}
      theme={state.context.theme.mode}
      locale={state.context.locale}
      onSession={setSession}
      onChange={reportChange}
      onUnsupported={reportUnsupported}
      onSaveSvg={async (svg) => {
        const path = svgPathFor(state.file!.path);
        try {
          await host.writeFile(path, svg);
          await host.toast({ kind: 'success', message: `Saved ${path}` });
        } catch (error) {
          await host.toast({ kind: 'error', message: `Could not save ${path}: ${error instanceof Error ? error.message : String(error)}`, copy: true });
        }
      }}
    />
  );
};

createRoot(container).render(<App />);
