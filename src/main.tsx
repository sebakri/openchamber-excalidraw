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
