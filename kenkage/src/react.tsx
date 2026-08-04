/**
 * kenkage — React integration
 *
 * Provides a hook and context provider for using the WASM engine
 * inside React components.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  createKenkage,
  type KenkageWasm,
} from './index';

// ── Hook return type ─────────────────────────────────────────────

interface UseKenkageReturn {
  /** The WASM engine instance (null while loading). */
  wasm: KenkageWasm | null;
  /** Whether the engine is still loading. */
  loading: boolean;
  /** Any error that occurred during loading or parsing. */
  error: Error | null;
  /** Parse a new HTML document. Returns true on success. */
  parse: (html: string) => boolean;
  /** Document title. */
  title: string;
  /** Full text content (tags stripped). */
  text: string;
  /** Serialized HTML. */
  html: string;
  /** Markdown conversion. */
  markdown: string;
  /** Total DOM node count. */
  nodeCount: number;
  /** Query elements by CSS selector. */
  querySelector: (sel: string) => number[];
  /** Get a node's tag name. */
  nodeTag: (id: number) => string;
  /** Get a node's text content. */
  nodeText: (id: number) => string;
}

// ── Context ───────────────────────────────────────────────────────

const KenkageContext = createContext<UseKenkageReturn | null>(null);

// ── Helper: derive state from engine ──────────────────────────────

function deriveState(wasm: KenkageWasm): Omit<UseKenkageReturn, 'wasm' | 'loading' | 'error' | 'parse' | 'querySelector' | 'nodeTag' | 'nodeText'> {
  return {
    title: wasm.getTitle(),
    text: wasm.getText(),
    html: wasm.getHtml(),
    markdown: wasm.getMarkdown(),
    nodeCount: wasm.getNodeCount(),
  };
}

// ── useKenkage hook ────────────────────────────────────────────

/**
 * React hook for the Kenkage WASM browser engine.
 *
 * Automatically initializes on mount and destroys on unmount.
 * Optionally parses HTML on mount if provided.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { text, title, loading, parse } = useKenkage();
 *   if (loading) return <p>Loading...</p>;
 *   return <div>{title}: {text}</div>;
 * }
 * ```
 */
export function useKenkage(html?: string): UseKenkageReturn {
  const engineRef = useRef<KenkageWasm | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [html_out, setHtmlOut] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [nodeCount, setNodeCount] = useState(0);

  // Initialize on mount
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const engine = await createKenkage();
        if (cancelled) {
          engine.destroy();
          return;
        }
        await engine.init();
        if (cancelled) {
          engine.destroy();
          return;
        }
        engineRef.current = engine;
        setLoading(false);

        // Auto-parse if HTML provided
        if (html !== undefined) {
          engine.parse(html);
          if (!cancelled) {
            const state = deriveState(engine);
            setTitle(state.title);
            setText(state.text);
            setHtmlOut(state.html);
            setMarkdown(state.markdown);
            setNodeCount(state.nodeCount);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (engineRef.current) {
        engineRef.current.destroy();
        engineRef.current = null;
      }
    };
    // Only run on mount/unmount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const parse = (newHtml: string): boolean => {
    const engine = engineRef.current;
    if (!engine) return false;
    const ok = engine.parse(newHtml);
    if (ok) {
      const state = deriveState(engine);
      setTitle(state.title);
      setText(state.text);
      setHtmlOut(state.html);
      setMarkdown(state.markdown);
      setNodeCount(state.nodeCount);
    }
    return ok;
  };

  const querySelector = (sel: string): number[] => {
    return engineRef.current?.querySelector(sel) ?? [];
  };

  const nodeTag = (id: number): string => {
    return engineRef.current?.nodeTag(id) ?? '';
  };

  const nodeText = (id: number): string => {
    return engineRef.current?.nodeText(id) ?? '';
  };

  return {
    wasm: engineRef.current,
    loading,
    error,
    parse,
    title,
    text,
    html: html_out,
    markdown,
    nodeCount,
    querySelector,
    nodeTag,
    nodeText,
  };
}

// ── Provider component ────────────────────────────────────────────

interface KenkageProviderProps {
  children: ReactNode;
  /** Optional HTML to parse immediately on mount. */
  html?: string;
  /** Optional WASM URL override. */
  wasmUrl?: string;
}

/**
 * React context provider that initializes the Kenkage engine
 * and makes it available to all children via `useKenkageContext()`.
 */
export function KenkageProvider({ children, html, wasmUrl: _wasmUrl }: KenkageProviderProps): React.JSX.Element {
  const hookResult = useKenkage(html);
  return (
    <KenkageContext.Provider value={hookResult}>
      {children}
    </KenkageContext.Provider>
  );
}

// ── Context consumer hook ─────────────────────────────────────────

/**
 * Access the Kenkage engine from a parent `KenkageProvider`.
 *
 * @throws Error if used outside of a `KenkageProvider`.
 */
export function useKenkageContext(): UseKenkageReturn {
  const ctx = useContext(KenkageContext);
  if (!ctx) {
    throw new Error(
      'useKenkageContext must be used within a <KenkageProvider>',
    );
  }
  return ctx;
}
