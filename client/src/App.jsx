import React, { useState, useEffect } from 'react';
import './index.css';

const API_BASE = '';  // Use relative URLs — works with Vite proxy in dev and express.static in prod

export default function App() {
  const [repos, setRepos] = useState([]);
  const [activeRepo, setActiveRepo] = useState(null);
  const [sidebarMode, setSidebarMode] = useState('tree'); // 'tree' | 'symbols' | 'search'

  // Tree state
  const [tree, setTree] = useState([]);
  const [activeBlob, setActiveBlob] = useState(null); // { id, name, path, content, size, is_binary }

  // Search & Symbols state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [symbolResults, setSymbolResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [symbolTypeFilter, setSymbolTypeFilter] = useState('');

  // Graph & Symbols state
  const [graphData, setGraphData] = useState(null);
  const [fileSymbols, setFileSymbols] = useState([]);
  const [activeTab, setActiveTab] = useState('code'); // 'code' | 'graph' | 'symbols'
  const [highlightLine, setHighlightLine] = useState(null);

  // Settings & Status
  const [embedModel, setEmbedModel] = useState('nomic-embed-text');
  const [error, setError] = useState(null);

  // Initial load: config + repositories
  useEffect(() => {
    fetch(`${API_BASE}/api/config`)
      .then(r => r.json())
      .then(d => { if (d.ai?.embedModel) setEmbedModel(d.ai.embedModel); })
      .catch(e => console.warn('Config fetch error:', e));

    fetch(`${API_BASE}/api/repos`)
      .then(r => r.json())
      .then(d => {
        const list = Array.isArray(d) ? d : [];
        setRepos(list);
        if (list.length > 0) {
          setActiveRepo(list[0]);
        }
      })
      .catch(e => setError(`Failed to load repositories: ${e.message}`));
  }, []);

  // Load tree when activeRepo changes
  useEffect(() => {
    if (activeRepo) {
      setTree([]);
      fetch(`${API_BASE}/api/repos/${activeRepo.id}/tree`)
        .then(r => r.json())
        .then(d => setTree(Array.isArray(d) ? d : []))
        .catch(e => setError(`Failed to load tree: ${e.message}`));
    }
  }, [activeRepo]);

  // Load blob content and related graph/symbols
  const loadBlob = async (blobId, fileName, filePath, targetRepoId = null) => {
    try {
      const res = await fetch(`${API_BASE}/api/blobs/${blobId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const resolvedPath = filePath || data.file_path || '';
      setActiveBlob({
        id: data.id,
        name: fileName || data.file_name || data.id,
        path: resolvedPath,
        content: data.content || '',
        size: data.size,
        is_binary: data.is_binary
      });

      // Fetch symbols for this blob
      fetch(`${API_BASE}/api/blobs/${blobId}/symbols`)
        .then(r => r.json())
        .then(syms => setFileSymbols(Array.isArray(syms) ? syms : []))
        .catch(() => setFileSymbols([]));

      // Fetch dependency graph for this file
      const effectiveRepoId = targetRepoId || activeRepo?.id;
      if (effectiveRepoId && resolvedPath) {
        const pathParam = encodeURIComponent(resolvedPath);
        fetch(`${API_BASE}/api/graph?file=${pathParam}&repo=${effectiveRepoId}`)
          .then(r => r.json())
          .then(g => setGraphData(g))
          .catch(() => setGraphData(null));
      }
    } catch (err) {
      setError(`Failed to load blob: ${err.message}`);
    }
  };

  // Debounced search for symbols & hybrid vector search
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setSymbolResults([]);
      setIsSearching(false);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      const repoParam = activeRepo ? `&repo=${activeRepo.id}` : '';
      const encodedQ = encodeURIComponent(searchQuery.trim());

      try {
        if (sidebarMode === 'symbols') {
          const typeParam = symbolTypeFilter ? `&type=${symbolTypeFilter}` : '';
          const res = await fetch(`${API_BASE}/api/symbols?q=${encodedQ}${repoParam}${typeParam}&limit=25`);
          const data = await res.json();
          setSymbolResults(Array.isArray(data) ? data : []);
        } else if (sidebarMode === 'search') {
          const res = await fetch(`${API_BASE}/api/search?q=${encodedQ}${repoParam}&limit=20`);
          const data = await res.json();
          setSearchResults(Array.isArray(data) ? data : []);
        }
      } catch (err) {
        setError(`Search error: ${err.message}`);
      } finally {
        setIsSearching(false);
      }
    }, 280);

    return () => clearTimeout(timer);
  }, [searchQuery, sidebarMode, symbolTypeFilter, activeRepo]);

  const handleSymbolClick = async (sym) => {
    if (sym.blob_id) {
      await loadBlob(sym.blob_id, sym.file_path?.split('/').pop(), sym.file_path, sym.repository_id);
      setHighlightLine(sym.start_line);
      setActiveTab('code');
    }
  };

  const handleSearchResultClick = async (item) => {
    if (item.id) {
      await loadBlob(item.id, item.file_name, item.file_path, item.repository_id);
      setHighlightLine(null);
      setActiveTab('code');
    }
  };

  return (
    <div className="dbos-layout">
      {error && (
        <div className="error-banner" onClick={() => setError(null)}>
          ⚠️ {error} <span className="close-btn">×</span>
        </div>
      )}

      {/* Top Application Header */}
      <header className="app-header">
        <div className="header-branding">
          <div className="brand-logo">⚡</div>
          <div className="brand-title">
            <span className="brand-name">krusch-git</span>
            <span className="brand-tag">Tier 2 Exploration</span>
          </div>
        </div>

        <div className="header-meta">
          <div className="meta-pill">
            <span className="pill-dot active"></span>
            <span>pgvector 1024-dim</span>
          </div>
          <div className="meta-pill">
            <span className="pill-label">Model:</span>
            <span className="pill-val">{embedModel}</span>
          </div>
          <div className="repo-selector-container">
            <label htmlFor="repo-select" className="repo-label">Repo:</label>
            <select 
              id="repo-select"
              value={activeRepo ? activeRepo.id : ''} 
              onChange={(e) => {
                const found = repos.find(r => r.id === parseInt(e.target.value, 10));
                setActiveRepo(found || null);
              }}
              className="repo-dropdown"
            >
              {repos.map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
        </div>
      </header>

      <div className="app-body">
        {/* Left Sidebar */}
        <aside className="sidebar">
          {/* Mode Switcher */}
          <div className="mode-tabs">
            <button 
              className={`mode-tab ${sidebarMode === 'tree' ? 'active' : ''}`}
              onClick={() => setSidebarMode('tree')}
              title="File Tree Explorer"
            >
              📂 Tree
            </button>
            <button 
              className={`mode-tab ${sidebarMode === 'symbols' ? 'active' : ''}`}
              onClick={() => setSidebarMode('symbols')}
              title="AST Symbol Search"
            >
              🧩 Symbols
            </button>
            <button 
              className={`mode-tab ${sidebarMode === 'search' ? 'active' : ''}`}
              onClick={() => setSidebarMode('search')}
              title="Hybrid Semantic Search"
            >
              🔍 Semantic
            </button>
          </div>

          {/* Search Input Bar (when in Symbols or Search mode) */}
          {sidebarMode !== 'tree' && (
            <div className="search-bar-container">
              <div className="search-input-wrapper">
                <input 
                  type="text"
                  placeholder={sidebarMode === 'symbols' ? "Find functions, classes, routes..." : "Semantic code search (BM25 + vectors)..."}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="search-input"
                  autoFocus
                />
                {searchQuery && (
                  <button className="clear-btn" onClick={() => setSearchQuery('')}>×</button>
                )}
              </div>

              {sidebarMode === 'symbols' && (
                <div className="symbol-filter-row">
                  {['', 'function', 'class', 'route', 'type'].map(t => (
                    <button 
                      key={t}
                      className={`type-pill ${symbolTypeFilter === t ? 'active' : ''}`}
                      onClick={() => setSymbolTypeFilter(t)}
                    >
                      {t || 'all'}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Sidebar Content Area */}
          <div className="sidebar-content">
            {sidebarMode === 'tree' && (
              <div className="tree-container">
                <div className="tree-header">
                  <span>FILES IN {activeRepo ? activeRepo.name.toUpperCase() : 'ROOT'}</span>
                  <span className="count-badge">{tree.length}</span>
                </div>
                <ul className="file-list">
                  {tree.length === 0 ? (
                    <li className="empty-item">No entries found</li>
                  ) : (
                    tree.map((item, idx) => (
                      <li 
                        key={idx}
                        className={`file-item ${activeBlob?.name === item.name ? 'active' : ''}`}
                        onClick={() => item.type === 'blob' && loadBlob(item.object_id, item.name, item.name)}
                      >
                        <span className="file-icon">{item.type === 'tree' ? '📁' : '📄'}</span>
                        <span className="file-name">{item.name}</span>
                      </li>
                    ))
                  )}
                </ul>
              </div>
            )}

            {sidebarMode === 'symbols' && (
              <div className="results-container">
                {isSearching ? (
                  <div className="loading-state">Scanning AST symbol graphs...</div>
                ) : !searchQuery.trim() ? (
                  <div className="hint-state">Type a symbol name to query declarations across {activeRepo ? activeRepo.name : 'repos'}.</div>
                ) : symbolResults.length === 0 ? (
                  <div className="empty-item">No matching symbols found.</div>
                ) : (
                  <ul className="symbol-list">
                    {symbolResults.map((s) => (
                      <li key={s.id} className="symbol-item" onClick={() => handleSymbolClick(s)}>
                        <div className="symbol-header-row">
                          <span className={`sym-badge sym-${s.symbol_type}`}>
                            {s.symbol_type}
                          </span>
                          <span className="sym-name">{s.symbol_name}</span>
                          <span className="sym-lines">L{s.start_line}-{s.end_line}</span>
                        </div>
                        {s.signature && (
                          <div className="sym-signature">{s.signature}</div>
                        )}
                        <div className="sym-path">{s.file_path}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {sidebarMode === 'search' && (
              <div className="results-container">
                {isSearching ? (
                  <div className="loading-state">Computing hybrid reciprocal rank fusion...</div>
                ) : !searchQuery.trim() ? (
                  <div className="hint-state">Search code semantics, comments, and logic with hybrid BM25 + pgvector.</div>
                ) : searchResults.length === 0 ? (
                  <div className="empty-item">No matching blobs found.</div>
                ) : (
                  <ul className="search-result-list">
                    {searchResults.map((item) => (
                      <li key={item.id} className="search-item" onClick={() => handleSearchResultClick(item)}>
                        <div className="search-item-header">
                          <span className="result-name">{item.file_name || item.id.substring(0, 10)}</span>
                          {item.similarity && (
                            <span className="result-score">
                              {(Number(item.similarity) * 100).toFixed(1)}% match
                            </span>
                          )}
                        </div>
                        <div className="result-path">{item.file_path || item.project}</div>
                        {item.summary && (
                          <div className="result-snippet">{item.summary}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </aside>

        {/* Main Editor & Graph Pane */}
        <main className="main-content">
          {/* Main Pane Navigation Tabs */}
          <div className="main-tabs-header">
            <button 
              className={`main-tab ${activeTab === 'code' ? 'active' : ''}`}
              onClick={() => setActiveTab('code')}
            >
              📄 {activeBlob?.name || 'Code Viewer'}
            </button>
            <button 
              className={`main-tab ${activeTab === 'graph' ? 'active' : ''}`}
              onClick={() => setActiveTab('graph')}
            >
              🕸️ Dependency Graph {graphData ? `(${graphData.dependents.length + graphData.imports.length})` : ''}
            </button>
            <button 
              className={`main-tab ${activeTab === 'symbols' ? 'active' : ''}`}
              onClick={() => setActiveTab('symbols')}
            >
              🧩 File Symbols ({fileSymbols.length})
            </button>
          </div>

          {/* Main Content Views */}
          <div className="main-tab-content">
            {activeTab === 'code' && (
              <div className="code-viewer-container">
                {activeBlob ? (
                  <div className="code-panel">
                    <div className="file-breadcrumbs">
                      <span className="bc-repo">{activeRepo?.name}</span>
                      <span className="bc-sep">/</span>
                      <span className="bc-path">{activeBlob.path || activeBlob.name}</span>
                      <span className="bc-meta">{activeBlob.size} bytes • SHA: {activeBlob.id.substring(0, 8)}</span>
                    </div>
                    {activeBlob.is_binary ? (
                      <div className="binary-notice">{activeBlob.content}</div>
                    ) : (
                      <div className="code-editor-layout">
                        <div className="code-lines">
                          {activeBlob.content.split('\n').map((line, idx) => {
                            const lineNum = idx + 1;
                            const isTarget = highlightLine === lineNum;
                            return (
                              <div key={idx} className={`code-row ${isTarget ? 'highlight-row' : ''}`}>
                                <span className="line-num">{lineNum}</span>
                                <span className="line-text">{line || ' '}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="placeholder-state">
                    <div className="placeholder-icon">🗂️</div>
                    <div className="placeholder-title">Select a file to inspect AST and Code</div>
                    <div className="placeholder-desc">Browse files from the Tree Explorer or search symbols and code across repositories.</div>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'graph' && (
              <div className="graph-viewer-container">
                {!graphData ? (
                  <div className="placeholder-state">
                    <div className="placeholder-icon">🕸️</div>
                    <div className="placeholder-title">No Dependency Graph Loaded</div>
                    <div className="placeholder-desc">Select a file to trace inbound callers and outbound imports.</div>
                  </div>
                ) : (
                  <div className="graph-panels-grid">
                    {/* Outbound Imports */}
                    <div className="graph-card">
                      <div className="graph-card-header">
                        <span>➡️ Outbound Imports</span>
                        <span className="card-badge">{graphData.imports.length}</span>
                      </div>
                      <div className="graph-card-body">
                        {graphData.imports.length === 0 ? (
                          <div className="empty-graph-note">No external imports found.</div>
                        ) : (
                          <ul className="graph-list">
                            {graphData.imports.map((imp, idx) => (
                              <li key={idx} className="graph-edge-item">
                                <span className="edge-target">{imp.target_path}</span>
                                {imp.symbols && (
                                  <span className="edge-symbols">[{imp.symbols}]</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>

                    {/* Inbound Dependents */}
                    <div className="graph-card">
                      <div className="graph-card-header">
                        <span>⬅️ Inbound Callers</span>
                        <span className="card-badge">{graphData.dependents.length}</span>
                      </div>
                      <div className="graph-card-body">
                        {graphData.dependents.length === 0 ? (
                          <div className="empty-graph-note">No files depend on this file yet.</div>
                        ) : (
                          <ul className="graph-list">
                            {graphData.dependents.map((dep, idx) => (
                              <li key={idx} className="graph-edge-item">
                                <span className="edge-target">{dep.source_path}</span>
                                {dep.symbols && (
                                  <span className="edge-symbols">[{dep.symbols}]</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'symbols' && (
              <div className="file-symbols-container">
                {fileSymbols.length === 0 ? (
                  <div className="placeholder-state">
                    <div className="placeholder-icon">🧩</div>
                    <div className="placeholder-title">No Symbols Extracted</div>
                    <div className="placeholder-desc">No function, class, or route declarations detected in this file.</div>
                  </div>
                ) : (
                  <div className="file-symbols-table-wrapper">
                    <table className="symbols-table">
                      <thead>
                        <tr>
                          <th>Type</th>
                          <th>Symbol Name</th>
                          <th>Lines</th>
                          <th>Signature</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fileSymbols.map(s => (
                          <tr 
                            key={s.id} 
                            onClick={() => {
                              setHighlightLine(s.start_line);
                              setActiveTab('code');
                            }}
                            className="clickable-symbol-row"
                          >
                            <td><span className={`sym-badge sym-${s.symbol_type}`}>{s.symbol_type}</span></td>
                            <td className="sym-cell-name">{s.symbol_name}</td>
                            <td className="sym-cell-lines">L{s.start_line}-{s.end_line}</td>
                            <td className="sym-cell-sig"><code>{s.signature || '-'}</code></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
