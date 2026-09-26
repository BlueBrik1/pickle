import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  AnalysisView,
  Candidate,
  FileRecord,
  RepositoryView,
  ScanSummary,
  SessionView,
} from '../shared/schema';
import { LIMITS } from '../shared/schema';
import {
  contentExclusionReason,
  exclusionReason,
  normalizePath,
  parseRootIgnore,
  sanitizeEnv,
} from '../shared/ingestion';
import { api } from './api';
import { Results } from './Results';

export const sampleRequests = [
  "Add account deletion to the settings page. Remove the user's profile, related records, stored files, and saved OAuth tokens.",
  'Rename the account status field.',
  'Change the upload storage bucket setting.',
];
const sampleLabels = [
  'Add account deletion to settings.',
  'Rename the account status field.',
  'Change the upload storage bucket setting.',
];
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement;
    ref.current?.showModal();
    return () => {
      prior?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button onClick={onClose} aria-label="Close dialog">
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function Source({
  repositoryId,
  file,
  line = 1,
}: {
  repositoryId: string;
  file: FileRecord;
  line?: number;
}) {
  const [source, setSource] = useState<{
    path: string;
    startLine: number;
    lines: string[];
    truncated: boolean;
  }>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setSource(undefined);
    setError('');
    api<{ path: string; startLine: number; lines: string[]; truncated: boolean }>(
      `/repositories/${repositoryId}/source/${file.id}?line=${line}`,
      undefined,
      undefined,
      controller.signal,
    )
      .then(setSource)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [repositoryId, file.id, line]);
  return (
    <div className="source">
      <p className="small break">{file.path} · source snapshot</p>
      {error ? (
        <p role="alert">{error}</p>
      ) : !source ? (
        <p>Loading source…</p>
      ) : (
        <>
          <div className="source-lines">
            {source.lines.map((text, i) => (
              <div key={i} className={source.startLine + i === line ? 'cited-line' : ''}>
                <span className="line-number">{source.startLine + i}</span>
                <code>{text || ' '}</code>
              </div>
            ))}
          </div>
          {source.truncated && (
            <p className="small">Excerpt truncated to the source display limit.</p>
          )}
          <p className="small muted">
            Escaped text. Best-effort redaction; line numbers refer to this snapshot.
          </p>
        </>
      )}
    </div>
  );
}
export function ScanLimits({ scan }: { scan?: ScanSummary }) {
  return (
    <details className="scan-limits">
      <summary>View scan limits</summary>
      <p>
        Static relationships are review evidence. They do not establish runtime behavior, production
        safety, or test completeness.
      </p>
      {scan && (
        <>
          <p>{scan.selectedConfiguration}</p>
          <p>
            {scan.acceptedFiles} accepted · {scan.parsedFiles} parsed · {scan.skippedFiles} skipped
            · {scan.unresolvedReferences.length} unresolved local references
          </p>
          {Object.entries(scan.skippedReasons).map(([reason, count]) => (
            <p key={reason}>
              {reason}: {count}
            </p>
          ))}
          <p>Supported rules: {scan.supportedRules.join(', ')}</p>
          {[...scan.warnings, ...scan.unsupportedPatterns, ...scan.unresolvedReferences].map(
            (w, i) => (
              <p key={i} className="break">
                {w}
              </p>
            ),
          )}
        </>
      )}
      <p>
        Only supported JS/TS imports and selected literal route, table, environment-name and
        document references are recognized. External packages, dynamic behavior and indirect test
        coverage are not followed.
      </p>
    </details>
  );
}

export function App() {
  const [path, setPath] = useState(location.pathname),
    [session, setSession] = useState<SessionView>(),
    [repository, setRepository] = useState<RepositoryView>(),
    [analysis, setAnalysis] = useState<AnalysisView>();
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [limits, setLimits] = useState(false),
    [mobileMenu, setMobileMenu] = useState(false),
    [importStage, setImportStage] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const refreshSession = useCallback(
    () =>
      api<SessionView>('/session')
        .then(setSession)
        .catch((e) => setError(e.message)),
    [],
  );
  const navigate = useCallback((url: string) => {
    history.pushState({}, '', url);
    setPath(url);
    setMobileMenu(false);
    setError('');
    setNotice('');
  }, []);
  useEffect(() => {
    const handler = () => {
      setPath(location.pathname);
      setError('');
    };
    addEventListener('popstate', handler);
    void refreshSession();
    return () => removeEventListener('popstate', handler);
  }, [refreshSession]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    setRepository(undefined);
    setAnalysis(undefined);
    const projectMatch = path.match(/^\/projects\/([^/]+)$/),
      analysisMatch = path.match(/^\/analyses\/([^/]+)$/);
    async function poll() {
      try {
        if (projectMatch) {
          const value = await api<RepositoryView>(
            `/repositories/${projectMatch[1]}`,
            undefined,
            undefined,
            controller.signal,
          );
          if (!active) return;
          setRepository(value);
          if (['queued', 'running'].includes(value.state)) timer = setTimeout(poll, 700);
          else void refreshSession();
        } else if (analysisMatch) {
          const value = await api<AnalysisView>(
            `/analyses/${analysisMatch[1]}`,
            undefined,
            undefined,
            controller.signal,
          );
          if (!active) return;
          setAnalysis(value);
          if (['queued', 'running'].includes(value.state)) timer = setTimeout(poll, 700);
          else void refreshSession();
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    }
    if (projectMatch || analysisMatch) void poll();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [path, refreshSession]);
  const act = async (fn: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const loadSample = () =>
    act(async () => {
      const value = await api<RepositoryView>('/repositories/sample', {});
      await refreshSession();
      navigate(`/projects/${value.id}`);
    });
  const clearProject = (id: string) =>
    act(async () => {
      await api(`/repositories/${id}`, undefined, 'DELETE');
      await refreshSession();
      navigate('/');
      setNotice('Project source and its analyses cleared from server memory.');
    });
  async function importFolder(list: FileList | null) {
    if (!list) return;
    await act(async () => {
      setImportStage('Reviewing selected files');
      const selected = Array.from(list);
      if (!selected.length)
        throw new Error('The folder is empty. Choose a folder with supported text files.');
      const root = selected[0].webkitRelativePath.split('/')[0];
      const seenPaths = new Set<string>();
      const seenCase = new Set<string>();
      const accepted: { relativePath: string; content: string }[] = [];
      const clientSkipped: Record<string, number> = {};
      let total = 0;
      const ignoreFile = selected.find((f) => f.webkitRelativePath === `${root}/.gitignore`);
      let ignoreText = '';
      if (ignoreFile && ignoreFile.size <= LIMITS.fileBytes) {
        try {
          ignoreText = new TextDecoder('utf-8', { fatal: true }).decode(
            await ignoreFile.arrayBuffer(),
          );
          if (contentExclusionReason(ignoreText)) ignoreText = '';
        } catch {
          /* Invalid ignore text will be skipped in the normal read pass. */
        }
      }
      const ignore = parseRootIgnore(ignoreText);
      const skip = (reason: string) => {
        clientSkipped[reason] = (clientSkipped[reason] ?? 0) + 1;
      };
      setImportStage('Filtering unsupported and excluded files');
      for (const file of selected) {
        if (!file.webkitRelativePath.startsWith(root + '/'))
          throw new Error('Selected files must share one selected folder root.');
        const relativePath = normalizePath(file.webkitRelativePath.slice(root.length + 1));
        if (seenPaths.has(relativePath) || seenCase.has(relativePath.toLowerCase()))
          throw new Error(
            'Duplicate or case-colliding paths are ambiguous. Rename them before importing.',
          );
        seenPaths.add(relativePath);
        seenCase.add(relativePath.toLowerCase());
        const reason = exclusionReason(relativePath);
        if (reason) {
          skip(reason);
          continue;
        }
        if (relativePath !== '.gitignore' && ignore.ignored(relativePath)) {
          skip('Root ignore rule');
          continue;
        }
        if (file.size > LIMITS.fileBytes) {
          skip('File exceeds 256 KiB');
          continue;
        }
        setImportStage(`Reading accepted files · ${accepted.length + 1}`);
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        } catch {
          skip('Malformed UTF-8');
          continue;
        }
        const contentReason = contentExclusionReason(content);
        if (contentReason) {
          skip(contentReason);
          continue;
        }
        if (/(^|\/)\.env\.(example|sample)$/i.test(relativePath)) content = sanitizeEnv(content);
        total += new TextEncoder().encode(content).length;
        if (total > LIMITS.totalBytes || accepted.length >= LIMITS.files)
          throw new Error(
            'Selection exceeds 1,500 accepted files or 8 MiB. Choose a smaller project.',
          );
        accepted.push({ relativePath, content });
      }
      if (!accepted.length)
        throw new Error('No supported files found. Choose a JS/TS project or try the sample.');
      setImportStage(
        `Sending ${accepted.length} accepted files · ${Object.values(clientSkipped).reduce((a, b) => a + b, 0)} skipped`,
      );
      const value = await api<RepositoryView>('/repositories/import', {
        name: root,
        files: accepted,
        clientSkipped,
      });
      await refreshSession();
      navigate(`/projects/${value.id}`);
    });
    setImportStage('');
    if (fileInput.current) fileInput.current.value = '';
  }
  const sidebar = (
    <>
      <a
        className="wordmark"
        href="/"
        onClick={(e) => {
          e.preventDefault();
          navigate('/');
        }}
      >
        <span className="brand-symbol" aria-hidden="true">
          ⌄
        </span>{' '}
        Pickle<span className="wordmark-dot">.</span>
      </a>
      <button
        className="new-analysis"
        onClick={() =>
          navigate(
            repository?.state === 'completed'
              ? `/projects/${repository.id}`
              : analysis
                ? `/projects/${analysis.repositoryId}`
                : '/',
          )
        }
      >
        ＋ New analysis
      </button>
      <div className="nav-section">
        <p className="overline">Projects</p>
        {session?.repositories.length ? (
          session.repositories.map((r) => (
            <button
              key={r.id}
              className={path === `/projects/${r.id}` ? 'nav-item active' : 'nav-item'}
              onClick={() => navigate(`/projects/${r.id}`)}
            >
              <span>▧</span>
              {r.name}
              <small>{r.scan?.acceptedFiles ?? '…'}</small>
            </button>
          ))
        ) : (
          <p className="small muted">No project loaded</p>
        )}
      </div>
      <div className="nav-section">
        <p className="overline">This session</p>
        {session?.analyses.length ? (
          session.analyses
            .slice()
            .reverse()
            .map((a, i) => (
              <button
                key={a.id}
                className={path === `/analyses/${a.id}` ? 'nav-item active' : 'nav-item'}
                onClick={() => navigate(`/analyses/${a.id}`)}
                title={a.requestText}
              >
                <span className="analysis-number">
                  {String(session.analyses.length - i).padStart(2, '0')}
                </span>
                <span className="ellipsis">{a.requestText}</span>
              </button>
            ))
        ) : (
          <p className="small muted">Your analyses appear here.</p>
        )}
      </div>
      <footer className="sidebar-footer">
        <span className="mode-dot" />{' '}
        {session?.mode === 'demo' ? 'Public sample demo' : 'Local mode'}
        <button className="text-button" onClick={() => setLimits(true)}>
          Scope & limitations ↗
        </button>
        <p className="small muted">Trace. Inspect. Plan.</p>
      </footer>
    </>
  );
  const known = path === '/' || /^\/(projects|analyses)\/[^/]+$/.test(path);
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Main navigation">
        {sidebar}
      </aside>
      {mobileMenu && (
        <Modal title="Navigation" onClose={() => setMobileMenu(false)}>
          <nav className="mobile-nav">{sidebar}</nav>
        </Modal>
      )}
      <div className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="mobile-toggle"
              onClick={() => setMobileMenu(true)}
              aria-label="Open navigation"
            >
              ☰
            </button>
            <span className="muted">Workspace</span>
            <span className="divider-text">/</span>
            <span>
              {repository?.name ??
                (analysis
                  ? session?.repositories.find((r) => r.id === analysis.repositoryId)?.name
                  : 'New analysis') ??
                'Pickle'}
            </span>
          </div>
          <span className="small top-state">
            {busy ? 'Processing' : (repository?.state ?? analysis?.state ?? 'Ready when you are')}
          </span>
        </header>
        <main>
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button
                onClick={() => {
                  setError('');
                  void refreshSession();
                }}
              >
                Dismiss & reconnect
              </button>
              {path !== '/' && <button onClick={() => navigate('/')}>Reload project</button>}
            </div>
          )}
          {notice && (
            <p role="status" className="success">
              {notice}
            </p>
          )}
          {path === '/' && (
            <div className="start-page">
              <p className="overline">A little context before a big change</p>
              <h1>
                Know what your
                <br />
                change touches.
              </h1>
              <p className="intro">
                Load a project, describe the change, and inspect the files and checks it may affect.
              </p>
              <div className="start-options">
                <section className="sample-option">
                  <div className="option-top">
                    <span className="overline">01 / Explore</span>
                    <span className="tag">Bundled sample</span>
                  </div>
                  <h2>Meet Pantry.</h2>
                  <p>
                    A small account app. One proposed deletion.
                    <br />
                    Follow the connections before changing code.
                  </p>
                  <button className="primary" onClick={loadSample} disabled={busy}>
                    Try the sample <span>↗</span>
                  </button>
                  <p className="small muted">TypeScript · API routes · SQL · tests</p>
                </section>
                <section className="folder-option">
                  <div className="option-top">
                    <span className="overline">02 / Bring your code</span>
                  </div>
                  <h2>Your project, in context.</h2>
                  <p>Choose a local folder to trace its supported files and references.</p>
                  {session?.mode === 'demo' ? (
                    <p className="notice">
                      Hosted demo: only the bundled public sample is enabled.
                    </p>
                  ) : (
                    <>
                      <button
                        disabled={
                          busy ||
                          !session ||
                          !('webkitdirectory' in document.createElement('input'))
                        }
                        onClick={() => fileInput.current?.click()}
                      >
                        Choose project folder <span>↗</span>
                      </button>
                      {!('webkitdirectory' in document.createElement('input')) && (
                        <p>Folder selection is unavailable in this browser. Try the sample.</p>
                      )}
                    </>
                  )}
                  <p className="small muted">Up to 1,500 text files · 8 MiB total</p>
                </section>
              </div>
              <input
                ref={fileInput}
                type="file"
                multiple
                {...{ webkitdirectory: '' }}
                hidden
                onChange={(e) => void importFolder(e.target.files)}
              />
              {importStage && (
                <p className="processing" role="status">
                  {importStage}
                </p>
              )}
              <div className="privacy-note">
                <span aria-hidden="true">↳</span>
                <div>
                  <p>
                    Pickle reads supported text files. It does not run your project or install
                    dependencies. Secret files and generated folders are excluded.
                  </p>
                  <p className="small muted">
                    {session?.mode === 'demo'
                      ? 'This hosted demo analyzes synthetic public material only.'
                      : 'Local mode sends selected supported files to the Pickle service on this machine.'}
                  </p>
                </div>
              </div>
              <div className="start-bottom">
                <span>Trace dependencies, inspect the evidence, and plan the change.</span>
                <button className="text-button" onClick={() => setLimits(true)}>
                  What can Pickle see? ↗
                </button>
              </div>
            </div>
          )}
          {path.startsWith('/projects/') && !repository && !error && (
            <p role="status">Loading project…</p>
          )}
          {repository && (
            <Project
              key={repository.id}
              repository={repository}
              busy={busy}
              act={act}
              navigate={navigate}
              clearProject={clearProject}
            />
          )}
          {path.startsWith('/analyses/') && !analysis && !error && (
            <p role="status">Loading analysis…</p>
          )}
          {analysis &&
            (analysis.state === 'completed' && analysis.result ? (
              <Results analysis={analysis} onChange={setAnalysis} onError={setError} />
            ) : (
              <div className="progress-page">
                <p className="overline">Analysis / {analysis.state}</p>
                <h1>
                  {analysis.state === 'canceled'
                    ? 'Analysis canceled.'
                    : analysis.state === 'failed'
                      ? 'Analysis could not finish.'
                      : 'Following the connections.'}
                </h1>
                <p className="request-quote">{analysis.requestText}</p>
                <p role="status" className="processing">
                  {analysis.error ?? analysis.stage}
                </p>
                <Elapsed
                  since={analysis.createdAt}
                  running={['running', 'queued'].includes(analysis.state)}
                />
                {['running', 'queued'].includes(analysis.state) ? (
                  <button
                    onClick={() =>
                      void act(async () => {
                        const value = await api<AnalysisView>(
                          `/analyses/${analysis.id}/cancel`,
                          {},
                        );
                        setAnalysis(value);
                      })
                    }
                    disabled={busy}
                  >
                    Cancel analysis
                  </button>
                ) : (
                  <button
                    className="primary"
                    onClick={() => navigate(`/projects/${analysis.repositoryId}`)}
                  >
                    Start another analysis ↗
                  </button>
                )}
              </div>
            ))}
          {!known && (
            <div className="progress-page">
              <h1>This page is unavailable.</h1>
              <p>The address may be incorrect or the session may have expired.</p>
              <button onClick={() => navigate('/')}>Load a project</button>
            </div>
          )}
        </main>
      </div>
      {limits && (
        <Modal title="What the snapshot can tell you" onClose={() => setLimits(false)}>
          <ScanLimits scan={repository?.scan ?? analysis?.result?.scan} />
          <p>
            Source is held in server memory for up to 30 idle minutes. Clear a project to remove its
            source and results. Refresh can recover your session; a service restart cannot.
          </p>
          <p>
            Requests help search for starting files. They are not interpreted by an LLM. Exports are
            a human-reviewed handoff; Bob does not run automatically.
          </p>
        </Modal>
      )}
    </div>
  );
}

function Elapsed({ since, running }: { since: string; running: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return (
    <p className="small muted">
      Elapsed: {Math.max(0, Math.floor((now - Date.parse(since)) / 1000))}s
    </p>
  );
}
function Project({
  repository: r,
  busy,
  act,
  navigate,
  clearProject,
}: {
  repository: RepositoryView;
  busy: boolean;
  act: (fn: () => Promise<void>) => Promise<void>;
  navigate: (p: string) => void;
  clearProject: (id: string) => void;
}) {
  const [request, setRequest] = useState(sampleRequests[0]),
    [candidates, setCandidates] = useState<Candidate[] | null>(null),
    [seeds, setSeeds] = useState<string[]>([]),
    [search, setSearch] = useState(''),
    [source, setSource] = useState<FileRecord>(),
    [depth, setDepth] = useState(3),
    [types, setTypes] = useState(true);
  const files = r.files ?? [];
  const ranked =
    candidates
      ?.map((c) => files.find((f) => f.id === c.fileId))
      .filter((f): f is FileRecord => !!f) ?? [];
  const shown = (
    search ? files.filter((f) => f.path.toLowerCase().includes(search.toLowerCase())) : ranked
  ).slice(0, 100);
  return (
    <div className="project-page">
      <div className="title-row">
        <div>
          <p className="overline">Project snapshot / {r.state}</p>
          <h1>{r.name}</h1>
        </div>
        <button className="danger-text" onClick={() => clearProject(r.id)} disabled={busy}>
          Clear project
        </button>
      </div>
      {r.state !== 'completed' ? (
        <>
          <p className="processing" role="status">
            {r.error ?? r.stage}
          </p>
          <Elapsed since={r.createdAt} running={['queued', 'running'].includes(r.state)} />
          {r.state === 'failed' && (
            <p>Clear this snapshot and try a smaller project or the sample.</p>
          )}
        </>
      ) : (
        <>
          <div className="project-facts">
            <span>
              <strong>{r.scan?.acceptedFiles}</strong> files accepted
            </span>
            <span>{((r.scan?.acceptedBytes ?? 0) / 1024).toFixed(1)} KiB</span>
            <span>{r.scan?.sourceFiles} source files</span>
            <span>{r.scan?.testFiles} tests</span>
            <span>{r.scan?.routes} routes</span>
            <span>{r.scan?.tables} tables</span>
          </div>
          <ScanLimits scan={r.scan} />
          <section className="request-section">
            <label htmlFor="change-request" className="section-heading">
              What are you changing?
            </label>
            <p className="muted">
              The request helps find starting files. Confirm them before analysis.
            </p>
            <textarea
              id="change-request"
              value={request}
              maxLength={2000}
              rows={4}
              onChange={(e) => {
                setRequest(e.target.value);
                setCandidates(null);
              }}
            />
            <div className="request-footer">
              <span className="small muted">
                {request.trim().length} / 2,000 characters · minimum 10
              </span>
              <button
                className="primary"
                disabled={busy || request.trim().length < 10}
                onClick={() =>
                  void act(async () => {
                    const value = await api<{ candidates: Candidate[] }>(
                      `/repositories/${r.id}/candidates`,
                      { requestText: request },
                    );
                    setCandidates(value.candidates);
                    setSeeds(
                      value.candidates
                        .filter(
                          (c) =>
                            c.strong &&
                            /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(
                              files.find((f) => f.id === c.fileId)?.path ?? '',
                            ) &&
                            !['test', 'docs'].includes(
                              files.find((f) => f.id === c.fileId)?.category ?? '',
                            ),
                        )
                        .slice(0, 3)
                        .map((c) => c.fileId),
                    );
                  })
                }
              >
                Find starting files ↗
              </button>
            </div>
            {r.name === 'Pantry' && (
              <div className="sample-requests">
                <span className="small muted">Try a request</span>
                {sampleLabels.map((text, i) => (
                  <button
                    className="text-button"
                    key={text}
                    onClick={() => {
                      setRequest(sampleRequests[i]);
                      setCandidates(null);
                    }}
                  >
                    {text}
                  </button>
                ))}
              </div>
            )}
          </section>
          {candidates && (
            <section className="candidate-section">
              <div className="title-row">
                <div>
                  <p className="overline">Your judgment, before the trace</p>
                  <h2>Confirm starting files.</h2>
                </div>
                <span>{seeds.length} / 8 selected</span>
              </div>
              {!candidates.some((c) => c.strong) && (
                <p>No strong match found. Select the files you expect to edit.</p>
              )}
              <label className="search-field">
                <span>Search all accepted files</span>
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by path…"
                />
              </label>
              <div className="candidate-list">
                {shown.map((f) => {
                  const candidate = candidates.find((c) => c.fileId === f.id);
                  return (
                    <div className="candidate" key={f.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={seeds.includes(f.id)}
                          disabled={!seeds.includes(f.id) && seeds.length >= 8}
                          onChange={(e) =>
                            setSeeds(
                              e.target.checked
                                ? [...seeds, f.id]
                                : seeds.filter((id) => id !== f.id),
                            )
                          }
                        />
                        <span>
                          <strong>{f.path}</strong>
                          <span className="small muted">
                            {candidate?.reasons.join(' · ') ||
                              'Manually selected from accepted files'}
                          </span>
                          <span className="small muted">
                            {candidate?.terms.length
                              ? 'Matched: ' + candidate.terms.join(', ')
                              : 'No request terms matched'}
                          </span>
                        </span>
                      </label>
                      <span className="tag">{f.category}</span>
                      <button onClick={() => setSource(f)} aria-label={`Inspect ${f.path}`}>
                        Inspect
                      </button>
                    </div>
                  );
                })}
                {!shown.length && <p>No paths match. Clear the search to see suggestions.</p>}
              </div>
              {shown.length === 100 && (
                <p className="small">Showing the first 100 matches. Narrow the path search.</p>
              )}
              <div className="analysis-settings">
                <label>
                  Dependent depth{' '}
                  <select value={depth} onChange={(e) => setDepth(+e.target.value)}>
                    {[1, 2, 3, 4, 5].map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={types}
                    onChange={(e) => setTypes(e.target.checked)}
                  />{' '}
                  Include type-only links
                </label>
                <span className="small muted">Inferred references are distinguished.</span>
              </div>
              <button
                className="primary"
                disabled={busy || !seeds.length}
                onClick={() =>
                  void act(async () => {
                    const value = await api<AnalysisView>('/analyses', {
                      repositoryId: r.id,
                      requestText: request,
                      seedFileIds: seeds,
                      settings: { maxDepth: depth, includeTypeOnly: types },
                    });
                    navigate(`/analyses/${value.id}`);
                  })
                }
              >
                Analyze impact <span>→</span>
              </button>
            </section>
          )}
        </>
      )}
      {source && (
        <Modal title="Supporting source" onClose={() => setSource(undefined)}>
          <Source repositoryId={r.id} file={source} />
        </Modal>
      )}
    </div>
  );
}
