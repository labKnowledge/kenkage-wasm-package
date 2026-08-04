import { NextRequest, NextResponse } from 'next/server';

// Fallback for the demo's "Fetch a live URL" feature: the browser's own
// fetch() is tried first and works for any CORS-friendly URL with zero
// server involvement. This route only exists for sites that block
// cross-origin browser requests — Node has no CORS restriction, so it can
// retrieve the bytes; the WASM engine still does 100% of the HTML parsing
// client-side, exactly as it does for the direct-fetch path.
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url');
  if (!url) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return NextResponse.json({ error: 'Only http/https URLs are supported' }, { status: 400 });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(parsed.toString(), {
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const body = await response.text();
    return NextResponse.json({ status: response.status, body });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
