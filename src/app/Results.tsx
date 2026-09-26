import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type NodeProps,
  type Node,
  type ReactFlowInstance,
} from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import type {
  AnalysisView,
  Evidence,
  FileImpact,
  FileRecord,
  PlanTask,
  ReviewState,
} from '../shared/schema';
import { api } from './api';
import { Modal, ScanLimits, Source } from './App';

const roleLabel = {
  seed: 'Starting file',
  dependent: 'Dependent',
  dependency: 'Dependency',
  reference: 'Reference candidate',
};
const testLabels = {
  direct: 'Direct test import found',
  possible: 'Possible test by naming/reference',
  'none-found': 'No direct test reference found',
  unknown: 'Unknown: scan incomplete',
  'not-applicable': 'Not applicable',
};
const groupLabels = {
  preparation: 'Preparation',
  backend: 'Data and backend',
  interface: 'Interface',
  tests: 'Tests',
  'docs-release': 'Documentation and release review',
};
type ImpactNode = Node<{ file: FileRecord; impact: FileImpact }, 'impact'>;
function GraphNode({ data, selected }: NodeProps<ImpactNode>) {
  return (
    <div className={`impact-node ${data.impact.primaryRole} ${selected ? 'selected' : ''}`}>
      <Handle type="source" position={Position.Right} />
      <Handle type="target" position={Position.Left} />
      <span className="small node-kind">
        {data.file.category}{' '}
        {data.impact.priority === 'high' && <span className="high-marker">● High</span>}
      </span>
      <strong>{data.file.path.split('/').pop()}</strong>
      <span className="small node-parent">
        {data.file.path.split('/').slice(0, -1).join('/') || 'Project root'}
      </span>
      <span className="small node-role">{roleLabel[data.impact.primaryRole]}</span>
    </div>
  );
}
const nodeTypes = { impact: GraphNode };
export function Results({
  analysis,
  onChange,
  onError,
}: {
  analysis: AnalysisView;
  onChange: (a: AnalysisView) => void;
  onError: (s: string) => void;
}) {
  const [medium, setMedium] = useState(
    () => matchMedia('(min-width:761px) and (max-width:1399px)').matches,
  );
  const [inspectorOpen, setInspectorOpen] = useState(false);
  useEffect(() => {
    const query = matchMedia('(min-width:761px) and (max-width:1399px)');
    const update = () => setMedium(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const reviewSequence = useRef(0);
  const r = analysis.result!;
  const [tab, setTab] = useState(() =>
    matchMedia('(max-width:700px)').matches ? 'Files' : 'Overview',
  );
  const [selected, setSelected] = useState(r.seedFileIds[0]),
    [edgeEvidence, setEdgeEvidence] = useState<string[] | null>(null),
    [search, setSearch] = useState(''),
    [role, setRole] = useState('all'),
    [category, setCategory] = useState('all'),
    [level, setLevel] = useState('all'),
    [priority, setPriority] = useState('all'),
    [tests, setTests] = useState(true),
    [docs, setDocs] = useState(true),
    [inferred, setInferred] = useState(true),
    [sort, setSort] = useState('priority'),
    [page, setPage] = useState(0),
    [exportOpen, setExportOpen] = useState(false),
    [success, setSuccess] = useState(''),
    [fallback, setFallback] = useState(''),
    [instance, setInstance] = useState<ReactFlowInstance<ImpactNode>>(),
    [sourceSpan, setSourceSpan] = useState<{ file: FileRecord; line: number }>();
  const fileMap = useMemo(() => new Map(r.files.map((f) => [f.id, f])), [r]);
  const evidenceLevel = (id: string) =>
    r.relationships
      .filter((e) => e.fromFileId === id || e.toFileId === id)
      .some((e) => e.level === 'structural')
      ? 'structural'
      : (r.relationships.find((e) => e.fromFileId === id || e.toFileId === id)?.level ?? 'unknown');
  const visible = r.impacts
    .filter((i) => {
      const f = fileMap.get(i.fileId)!;
      return (
        (!search ||
          `${f.path} ${r.evidence
            .filter((e) => e.spans.some((s) => s.fileId === f.id))
            .map((e) => e.matchedValue ?? '')
            .join(' ')}`
            .toLowerCase()
            .includes(search.toLowerCase())) &&
        (role === 'all' || i.primaryRole === role) &&
        (category === 'all' || f.category === category) &&
        (priority === 'all' || i.priority === priority) &&
        (level === 'all' || evidenceLevel(f.id) === level) &&
        (tests || f.category !== 'test') &&
        (docs || f.category !== 'docs') &&
        (inferred || evidenceLevel(f.id) !== 'inferred-reference')
      );
    })
    .sort((a, b) =>
      sort === 'path'
        ? fileMap.get(a.fileId)!.path.localeCompare(fileMap.get(b.fileId)!.path)
        : sort === 'category'
          ? fileMap.get(a.fileId)!.category.localeCompare(fileMap.get(b.fileId)!.category) ||
            fileMap.get(a.fileId)!.path.localeCompare(fileMap.get(b.fileId)!.path)
          : (b.score ?? -1) - (a.score ?? -1) ||
            Number(evidenceLevel(b.fileId) === 'structural') -
              Number(evidenceLevel(a.fileId) === 'structural') ||
            fileMap.get(a.fileId)!.path.localeCompare(fileMap.get(b.fileId)!.path),
    );
  const graphImpacts = [...visible]
    .sort(
      (a, b) =>
        Number(b.primaryRole === 'seed') - Number(a.primaryRole === 'seed') ||
        fileMap.get(a.fileId)!.path.localeCompare(fileMap.get(b.fileId)!.path),
    )
    .slice(0, 120);
  const graphIds = new Set(graphImpacts.map((i) => i.fileId));
  const graphEdges = r.relationships.filter(
    (e) =>
      graphIds.has(e.fromFileId) &&
      graphIds.has(e.toFileId) &&
      (inferred || e.level !== 'inferred-reference'),
  );
  const renderedEdges = graphEdges.slice(0, 200);
  const graph = useMemo(() => {
    const layout = new dagre.graphlib.Graph();
    layout.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 96 });
    layout.setDefaultEdgeLabel(() => ({}));
    for (const i of graphImpacts) layout.setNode(i.fileId, { width: 224, height: 116 });
    for (const e of renderedEdges) layout.setEdge(e.fromFileId, e.toFileId);
    dagre.layout(layout);
    return {
      nodes: graphImpacts.map((i) => ({
        id: i.fileId,
        type: 'impact' as const,
        data: { file: fileMap.get(i.fileId)!, impact: i },
        position: { x: layout.node(i.fileId).x - 112, y: layout.node(i.fileId).y - 58 },
        selected: i.fileId === selected,
        ariaLabel: `${fileMap.get(i.fileId)!.path}, ${roleLabel[i.primaryRole]}`,
      })),
      edges: renderedEdges.map((e) => ({
        id: e.id,
        source: e.fromFileId,
        target: e.toFileId,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#f3f0e8' },
        style: {
          stroke: '#f3f0e8',
          strokeOpacity: 0.65,
          strokeDasharray: e.typeOnly ? '2 5' : e.level === 'structural' ? undefined : '7 5',
        },
        ariaLabel: `${e.kind}: ${fileMap.get(e.fromFileId)?.path} depends on or references ${fileMap.get(e.toFileId)?.path}`,
        label: evidenceSelected(e.evidenceIds) ? e.kind : undefined,
      })),
    };
    function evidenceSelected(ids: string[]) {
      return edgeEvidence?.some((id) => ids.includes(id));
    }
  }, [
    graphImpacts.map((i) => i.fileId).join(','),
    renderedEdges.map((e) => e.id).join(','),
    selected,
    edgeEvidence,
  ]);
  const selectedFile = fileMap.get(selected),
    selectedImpact = r.impacts.find((i) => i.fileId === selected);
  const selectedEvidence = r.evidence.filter((e) =>
    edgeEvidence
      ? edgeEvidence.includes(e.id)
      : e.spans.some((s) => s.fileId === selected) ||
        r.relationships.some(
          (link) =>
            (link.fromFileId === selected || link.toFileId === selected) &&
            link.evidenceIds.includes(e.id),
        ),
  );
  function reset() {
    setSearch('');
    setRole('all');
    setCategory('all');
    setLevel('all');
    setPriority('all');
    setTests(true);
    setDocs(true);
    setInferred(true);
    setPage(0);
  }
  const filtered =
    search ||
    role !== 'all' ||
    category !== 'all' ||
    level !== 'all' ||
    priority !== 'all' ||
    !tests ||
    !docs ||
    !inferred;
  async function exportFile(format: 'markdown' | 'json' | 'bob', copy = false) {
    try {
      setSuccess('');
      const response = await fetch(`/api/analyses/${analysis.id}/export?format=${format}`);
      if (!response.ok) throw new Error('Export failed. The snapshot may have expired.');
      const text = await response.text();
      if (copy) {
        try {
          await navigator.clipboard.writeText(text);
          setSuccess('Bob handoff copied. Review it before use.');
        } catch {
          setFallback(text);
        }
      } else {
        const blob = new Blob([text], {
          type: format === 'json' ? 'application/json' : 'text/markdown',
        });
        const url = URL.createObjectURL(blob),
          link = document.createElement('a');
        link.href = url;
        link.download =
          format === 'json'
            ? 'pickle-analysis.json'
            : format === 'bob'
              ? 'pickle-bob-handoff.md'
              : 'pickle-impact-report.md';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setSuccess('Export generated. No external agent has been run.');
      }
      setExportOpen(false);
    } catch (e) {
      onError((e as Error).message);
    }
  }
  async function updateReview(taskId: string, change: ReviewState[string]) {
    const sequence = ++reviewSequence.current;
    const next = { ...analysis.review, [taskId]: { ...analysis.review[taskId], ...change } };
    onChange({ ...analysis, review: next });
    try {
      const response = await api<AnalysisView | ReviewState>(
        `/analyses/${analysis.id}/review`,
        next,
        'PATCH',
      );
      if (sequence !== reviewSequence.current) return;
      onChange({
        ...analysis,
        review:
          'review' in response ? (response as AnalysisView).review : (response as ReviewState),
      });
    } catch (e) {
      if (sequence === reviewSequence.current) onChange(analysis);
      onError((e as Error).message);
    }
  }
  const selectFile = (id: string) => {
    // A test can be cited from the full scan without belonging to the bounded impact set.
    // Keep its evidence inspectable without inventing an impact role or score.
    if (!r.impacts.some((impact) => impact.fileId === id)) {
      const file = fileMap.get(id);
      if (file) setSourceSpan({ file, line: 1 });
      return;
    }
    setSelected(id);
    setEdgeEvidence(null);
    if (medium) setInspectorOpen(true);
  };
  const inspector = (
    <aside className="inspector" aria-label="File inspector">
      {selectedFile && selectedImpact ? (
        <>
          <p className="overline">Evidence inspector</p>
          <div className="inspector-file">
            <h2>{selectedFile.path.split('/').pop()}</h2>
            <span className="tag">{selectedFile.category}</span>
          </div>
          <p className="small break">{selectedFile.path}</p>
          <button
            className="text-button small"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(selectedFile.path)
                .then(() => setSuccess('Relative path copied.'))
                .catch(() => setFallback(selectedFile.path));
              if (!navigator.clipboard) setFallback(selectedFile.path);
            }}
          >
            Copy path
          </button>
          <div className="inspector-summary">
            <span>{roleLabel[selectedImpact.primaryRole]}</span>
            <Priority impact={selectedImpact} />
          </div>
          <p className="small muted">
            Classification: {selectedFile.categoryBasis.replaceAll('-', ' ')}.{' '}
            {selectedImpact.primaryRole === 'seed'
              ? 'Included because you confirmed this starting file.'
              : 'Included through the relationships below.'}
          </p>
          <details open>
            <summary>Review-priority rules</summary>
            {selectedImpact.scoreComponents.length ? (
              selectedImpact.scoreComponents.map((c) => (
                <div key={c.ruleId} className="score-rule">
                  <span>
                    <strong>{c.ruleId.replaceAll('-', ' ')}</strong>
                    <span className="small muted block">
                      {c.explanation}
                      {c.requestDerived ? ' · User input' : ''}
                    </span>
                  </span>
                  <span>+{c.points}</span>
                </div>
              ))
            ) : (
              <p>
                Not assessed. Test and document files are not assigned implementation review scores.
              </p>
            )}
          </details>
          <details>
            <summary>Path to a starting file</summary>
            {selectedImpact.explanationPath.length ? (
              <ol>
                {selectedImpact.explanationPath.map((id) => {
                  const e = r.relationships.find((link) => link.id === id);
                  return e ? (
                    <li key={id} className="small break">
                      {fileMap.get(e.fromFileId)?.path} → {fileMap.get(e.toFileId)?.path} ({e.kind}
                      {e.typeOnly ? ', type-only' : ''})
                    </li>
                  ) : null;
                })}
              </ol>
            ) : (
              <p className="small">
                Confirmed starting file, or attached context; see source evidence below.
              </p>
            )}
            <p className="small muted">Path intermediates may be hidden by your current filters.</p>
          </details>
          <h3>Supporting evidence</h3>
          {selectedEvidence.length ? (
            selectedEvidence.map((e) => (
              <EvidenceCard
                key={e.id}
                evidence={e}
                files={fileMap}
                open={(file, line) => setSourceSpan({ file, line })}
              />
            ))
          ) : (
            <p className="small muted">
              This file was user-selected. No supported relationship evidence was extracted.
            </p>
          )}
          <h3>Tests to inspect</h3>
          <p className="small">{testLabels[selectedImpact.testReferences.status]}</p>
          {selectedImpact.testReferences.testFileIds.map((id) => (
            <button className="text-button small break" key={id} onClick={() => selectFile(id)}>
              {fileMap.get(id)?.path}
            </button>
          ))}
          <p className="small muted">
            An import does not establish assertions for the proposed behavior or measured coverage.
          </p>
          <h3>Suggested review</h3>
          {r.plan
            .filter((t) => t.fileIds.includes(selected))
            .map((t) => (
              <p className="small" key={t.id}>
                {t.title}
              </p>
            ))}
          <button onClick={() => setSourceSpan({ file: selectedFile, line: 1 })}>
            Inspect source
          </button>
        </>
      ) : (
        <p>Select a file or edge to inspect its evidence.</p>
      )}
    </aside>
  );
  return (
    <div className="results-page">
      <div className="title-row result-title">
        <div>
          <p className="overline">
            Snapshot {r.snapshotFingerprint.slice(0, 10)} ·{' '}
            {new Date(r.completedAt).toLocaleString()} · {Math.round(r.durationMs)} ms
          </p>
          <h1>
            Change impact<span className="title-period">.</span>
          </h1>
        </div>
        <div className="export-wrap">
          <button
            className="primary"
            aria-label="Export"
            aria-expanded={exportOpen}
            onClick={() => setExportOpen(!exportOpen)}
          >
            Export <span>↓</span>
          </button>
          {exportOpen && (
            <div className="export-menu">
              <button onClick={() => void exportFile('markdown')}>Download Markdown report</button>
              <button onClick={() => void exportFile('json')}>Download JSON result</button>
              <button onClick={() => void exportFile('bob')}>Export for Bob</button>
              <button onClick={() => void exportFile('bob', true)}>Copy Bob handoff</button>
            </div>
          )}
        </div>
      </div>
      <p className="request-quote">{r.requestText}</p>
      {success && (
        <p className="success" role="status">
          {success}
        </p>
      )}
      <div className="summary-strip">
        {[
          ['Confirmed starting files', r.impacts.filter((i) => i.primaryRole === 'seed').length],
          ['Structural dependents', r.impacts.filter((i) => i.primaryRole === 'dependent').length],
          [
            'Additional reference candidates',
            r.impacts.filter((i) => i.primaryRole === 'reference').length,
          ],
          [
            'Direct test references',
            new Set(
              r.impacts.flatMap((i) =>
                i.testReferences.status === 'direct' ? i.testReferences.testFileIds : [],
              ),
            ).size,
          ],
        ].map(([label, value]) => (
          <div key={label}>
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <p className="scope-note">
        This report identifies supported relationships in the scanned snapshot. It does not prove
        that a file will break or that the change is safe.
      </p>
      {!r.impacts.some((i) => i.primaryRole === 'dependent') && (
        <p className="small muted">
          No structural dependents were found within the selected depth. Inspect immediate
          dependencies and supported references separately.
        </p>
      )}
      <nav className="tabs" aria-label="Result views">
        {['Overview', 'Files', 'Plan', 'Checks'].map((t) => (
          <button key={t} aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}>
            {t}
            {t === 'Files' && <span>{r.impacts.length}</span>}
            {t === 'Plan' && <span>{r.plan.length}</span>}
          </button>
        ))}
      </nav>
      {['Overview', 'Files'].includes(tab) && (
        <>
          <div className="filter-bar">
            <label className="search-field">
              <span className="sr-only">Search results by path or symbol</span>
              <input
                placeholder="Search paths or symbols…"
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
              />
            </label>
            <label>
              <span className="sr-only">Role</span>
              <select
                aria-label="Filter role"
                value={role}
                onChange={(e) => {
                  setRole(e.target.value);
                  setPage(0);
                }}
              >
                <option value="all">All roles</option>
                {Object.entries(roleLabel).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">Category</span>
              <select
                aria-label="Filter category"
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  setPage(0);
                }}
              >
                <option value="all">All categories</option>
                {[...new Set(r.files.map((f) => f.category))].sort().map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <select
              aria-label="Filter evidence"
              value={level}
              onChange={(e) => {
                setLevel(e.target.value);
                setPage(0);
              }}
            >
              <option value="all">All evidence</option>
              {['structural', 'supported-reference', 'inferred-reference', 'unknown'].map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
            <select
              aria-label="Filter priority"
              value={priority}
              onChange={(e) => {
                setPriority(e.target.value);
                setPage(0);
              }}
            >
              <option value="all">All priorities</option>
              {['high', 'medium', 'low', 'not-assessed'].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <button className="text-button" onClick={reset}>
              Reset filters
            </button>
          </div>
          <div className="filter-meta">
            <div className="toggle-row">
              <label>
                <input
                  type="checkbox"
                  checked={tests}
                  onChange={(e) => {
                    setTests(e.target.checked);
                    setPage(0);
                  }}
                />{' '}
                Tests
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={docs}
                  onChange={(e) => {
                    setDocs(e.target.checked);
                    setPage(0);
                  }}
                />{' '}
                Documents
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={inferred}
                  onChange={(e) => {
                    setInferred(e.target.checked);
                    setPage(0);
                  }}
                />{' '}
                Inferred references
              </label>
            </div>
            <span className="small muted" aria-live="polite">
              {visible.length} of {r.impacts.length} files{filtered ? ' · filters active' : ''}
            </span>
          </div>
          <div className="inspection-layout">
            <section
              className={tab === 'Overview' ? 'graph-panel' : 'table-panel'}
              aria-label={tab === 'Overview' ? 'Dependency graph' : 'Affected files'}
            >
              {tab === 'Overview' ? (
                <>
                  <div className="panel-heading">
                    <h2>Follow the relationships</h2>
                    <button
                      className="text-button"
                      onClick={() =>
                        void instance?.fitView({
                          nodes: [{ id: r.seedFileIds[0] }],
                          minZoom: 0.7,
                          maxZoom: 0.8,
                          padding: 0.3,
                        })
                      }
                    >
                      Reset view ↗
                    </button>
                  </div>
                  <div className="graph-canvas">
                    {graph.nodes.length ? (
                      <ReactFlow<ImpactNode>
                        nodes={graph.nodes}
                        edges={graph.edges}
                        nodeTypes={nodeTypes}
                        onInit={setInstance}
                        onNodeClick={(_, node) => selectFile(node.id)}
                        onEdgeClick={(_, edge) => {
                          const link = r.relationships.find((e) => e.id === edge.id);
                          if (link) {
                            setSelected(link.fromFileId);
                            setEdgeEvidence(link.evidenceIds);
                            if (medium) setInspectorOpen(true);
                          }
                        }}
                        fitView
                        fitViewOptions={{
                          nodes: [{ id: r.seedFileIds[0] }],
                          minZoom: 0.7,
                          maxZoom: 0.8,
                          padding: 0.3,
                        }}
                        minZoom={0.15}
                        maxZoom={1.8}
                        nodesDraggable={false}
                        colorMode="dark"
                        proOptions={{ hideAttribution: true }}
                      >
                        <Background color="rgba(243,240,232,0.18)" gap={24} size={1} />
                        <Controls showInteractive={false} />
                      </ReactFlow>
                    ) : (
                      <div className="empty-state">
                        No files match these filters. <button onClick={reset}>Reset filters</button>
                      </div>
                    )}
                  </div>
                  <div className="graph-legend">
                    <span>Pan to explore · Fit view shows all</span>
                    <span>→ Dependent points to dependency</span>
                    <span>━ Structural</span>
                    <span>┄ Reference</span>
                    <span>┈ Type-only</span>
                  </div>
                  {(visible.length > 120 || graphEdges.length > 200) && (
                    <p className="limit-note">
                      Graph display capped: {visible.length - graph.nodes.length} files and{' '}
                      {graphEdges.length - graph.edges.length} edges hidden. Narrow filters or open
                      Files for every result.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <div className="panel-heading">
                    <h2>Files to inspect</h2>
                    <label className="small">
                      Sort{' '}
                      <select value={sort} onChange={(e) => setSort(e.target.value)}>
                        <option value="priority">Review priority</option>
                        <option value="path">File path</option>
                        <option value="category">Category</option>
                      </select>
                    </label>
                  </div>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>File</th>
                          <th>Category / role</th>
                          <th>Evidence</th>
                          <th>Review priority</th>
                          <th>Test-reference status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visible.slice(page * 25, page * 25 + 25).map((i) => {
                          const f = fileMap.get(i.fileId)!;
                          return (
                            <tr key={f.id} className={selected === f.id ? 'selected-row' : ''}>
                              <td>
                                <button className="file-link" onClick={() => selectFile(f.id)}>
                                  {f.path}
                                </button>
                              </td>
                              <td>
                                {f.category}
                                <span className="small muted block">
                                  {roleLabel[i.primaryRole]}
                                </span>
                              </td>
                              <td>{evidenceLevel(f.id).replaceAll('-', ' ')}</td>
                              <td>
                                <Priority impact={i} />
                              </td>
                              <td>{testLabels[i.testReferences.status]}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {!visible.length && (
                      <div className="empty-state">
                        No files match. <button onClick={reset}>Reset filters</button>
                      </div>
                    )}
                  </div>
                  <div className="pagination">
                    <button disabled={page === 0} onClick={() => setPage(page - 1)}>
                      Previous
                    </button>
                    <span className="small">
                      Page {page + 1} of {Math.max(1, Math.ceil(visible.length / 25))}
                    </span>
                    <button
                      disabled={(page + 1) * 25 >= visible.length}
                      onClick={() => setPage(page + 1)}
                    >
                      Next
                    </button>
                  </div>
                </>
              )}
            </section>
            {medium ? (
              <button className="inspector-trigger" onClick={() => setInspectorOpen(true)}>
                Inspect selected file ↗
              </button>
            ) : (
              inspector
            )}
          </div>
        </>
      )}
      {tab === 'Plan' && (
        <section className="plan-page">
          <div className="section-intro">
            <h2>A plan grounded in the snapshot.</h2>
            <p>
              Review and edit these suggested tasks. Checkmarks mean{' '}
              <strong>completed by user</strong>; they do not verify code or change review scores.
            </p>
          </div>
          {Object.entries(groupLabels).map(([key, label]) => {
            const tasks = r.plan.filter((t) => t.group === key);
            return tasks.length ? (
              <section className="task-group" key={key}>
                <h3>
                  {label}
                  <span className="muted small"> / {tasks.length}</span>
                </h3>
                {tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    review={analysis.review[task.id]}
                    files={fileMap}
                    update={(change) => void updateReview(task.id, change)}
                  />
                ))}
              </section>
            ) : null;
          })}
        </section>
      )}
      {tab === 'Checks' && (
        <section className="checks-page">
          <h2>What to inspect. What to establish.</h2>
          <p className="muted">Pickle does not execute tests or measure coverage.</p>
          <div className="checks-columns">
            <section>
              <p className="overline">Observed</p>
              <h3>Existing tests to inspect</h3>
              {[...new Set(r.impacts.flatMap((i) => i.testReferences.testFileIds))].map((id) => (
                <div className="check-item" key={id}>
                  <button
                    className="file-link"
                    onClick={() => {
                      selectFile(id);
                      setTab('Files');
                    }}
                  >
                    {fileMap.get(id)?.path}
                  </button>
                  <p className="small muted">
                    Inspect the actual assertions before relying on this reference.
                  </p>
                </div>
              ))}
              {!r.impacts.some((i) => i.testReferences.testFileIds.length) && (
                <p>No matching tests were found in the scanned snapshot.</p>
              )}
            </section>
            <section>
              <p className="overline">Proposed</p>
              <h3>Suggested tests to add</h3>
              {r.plan
                .filter((t) => t.group === 'tests')
                .map((t) => (
                  <div className="check-item" key={t.id}>
                    <strong>{t.title}</strong>
                    <p className="small muted">{t.description}</p>
                    <span className="small">
                      {t.requestDerived
                        ? 'Request-derived review question'
                        : 'Suggested from observed relationships'}
                    </span>
                  </div>
                ))}
            </section>
            <section>
              <p className="overline">Human review</p>
              <h3>Manual checks</h3>
              <div className="check-item">
                <strong>Confirm the checkout matches this snapshot.</strong>
                <p className="small muted">
                  A later edit may change every relationship in this report.
                </p>
              </div>
              {r.plan
                .filter((t) => t.requestDerived && t.group !== 'tests')
                .map((t) => (
                  <div className="check-item" key={t.id}>
                    <strong>{t.title}</strong>
                    <p className="small muted">Request-derived review question: {t.description}</p>
                  </div>
                ))}
              <div className="check-item">
                <strong>Review runtime assumptions.</strong>
                <p className="small muted">
                  Confirm ownership, configuration, middleware and deployed schema in a trusted
                  environment. Run relevant tests there with normal execution permissions.
                </p>
              </div>
            </section>
          </div>
        </section>
      )}
      <div className="report-footer">
        <ScanLimits scan={r.scan} />
        <span className="small muted">
          {r.analyzerVersion} · rules {r.rulesVersion} ·{' '}
          {r.impacts.filter((i) => i.primaryRole === 'dependency').length} immediate dependencies ·{' '}
          {r.relationships.length} relationships
        </span>
      </div>
      {medium && inspectorOpen && (
        <Modal title="File inspector" onClose={() => setInspectorOpen(false)}>
          {inspector}
        </Modal>
      )}
      {sourceSpan && (
        <Modal title="Source evidence" onClose={() => setSourceSpan(undefined)}>
          <Source repositoryId={r.repositoryId} file={sourceSpan.file} line={sourceSpan.line} />
        </Modal>
      )}
      {fallback && (
        <Modal title="Copy manually" onClose={() => setFallback('')}>
          <p>Clipboard access is unavailable. Select and copy the text below.</p>
          <textarea
            aria-label="Text to copy"
            value={fallback}
            readOnly
            rows={12}
            onFocus={(e) => e.target.select()}
          />
        </Modal>
      )}
    </div>
  );
}
function Priority({ impact }: { impact: FileImpact }) {
  return (
    <span className={`priority ${impact.priority}`}>
      {impact.score === null
        ? 'Not assessed'
        : `${impact.score} · ${impact.priority[0].toUpperCase() + impact.priority.slice(1)}`}
    </span>
  );
}
function EvidenceCard({
  evidence: e,
  files,
  open,
}: {
  evidence: Evidence;
  files: Map<string, FileRecord>;
  open: (file: FileRecord, line: number) => void;
}) {
  return (
    <div className="evidence-card">
      <span className="overline">{e.level.replaceAll('-', ' ')}</span>
      <p>{e.summary}</p>
      {e.spans.map((s, i) => {
        const f = files.get(s.fileId);
        return f ? (
          <button className="source-link" key={i} onClick={() => open(f, s.startLine)}>
            {f.path}
            <span>
              L{s.startLine}:{s.startColumn} ↗
            </span>
          </button>
        ) : null;
      })}
      {e.limitations.map((l, i) => (
        <p className="small muted" key={i}>
          {l}
        </p>
      ))}
    </div>
  );
}
function TaskRow({
  task: t,
  review,
  files,
  update,
}: {
  task: PlanTask;
  review?: ReviewState[string];
  files: Map<string, FileRecord>;
  update: (change: ReviewState[string]) => void;
}) {
  return (
    <div className={`task-row ${review?.completed ? 'completed' : ''}`}>
      <label className="task-checkbox">
        <input
          type="checkbox"
          aria-label={`Complete ${t.title}`}
          checked={review?.completed ?? false}
          onChange={(e) => update({ completed: e.target.checked })}
        />
      </label>
      <div>
        <input
          className="task-title"
          aria-label={`Task wording: ${t.title}`}
          defaultValue={review?.title ?? t.title}
          onBlur={(e) => {
            if (e.target.value !== (review?.title ?? t.title)) update({ title: e.target.value });
          }}
        />
        <p className="small muted">{t.description}</p>
        <div className="task-paths">
          {t.fileIds.map((id) => (
            <span className="tag" key={id}>
              {files.get(id)?.path}
            </span>
          ))}
        </div>
        {t.suggestedNewPaths.map((p) => (
          <p className="small" key={p}>
            Suggested new file: {p}
          </p>
        ))}
        <p className="small muted">
          {t.requestDerived ? 'Request-derived review question' : 'Generated from observed facts'} ·
          Workstream: {groupLabels[t.group]}
          {t.dependsOnTaskIds.length ? ` · Prerequisites: ${t.dependsOnTaskIds.join(', ')}` : ''}
        </p>
        <label className="small">
          User note
          <textarea
            rows={2}
            maxLength={2000}
            aria-label={`Note for ${t.title}`}
            defaultValue={review?.note ?? ''}
            placeholder="Add a review note…"
            onBlur={(e) => {
              if (e.target.value !== (review?.note ?? '')) update({ note: e.target.value });
            }}
          />
        </label>
        {(review?.completed || review?.note || review?.title) && (
          <span className={review.completed ? 'success small' : 'small'}>
            {review.completed ? 'Completed by user' : 'User edits'}
            {review.note || review.title ? ' · includes user edits' : ''}
          </span>
        )}
      </div>
    </div>
  );
}
