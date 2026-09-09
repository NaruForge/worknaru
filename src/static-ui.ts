import { createReadStream, lstatSync, readFileSync, realpathSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ChatError as AppError } from './chat-contract.js';

const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function resolveWebRoot(projectRoot: string) {
  const root = realpathSync(projectRoot);
  const target = resolve(root, 'dist', 'web');
  const part = relative(root, target);
  if (part !== join('dist', 'web')) {
    throw new AppError('WEB_UI_UNAVAILABLE', '번들 UI 경로가 올바르지 않습니다.');
  }
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new AppError('WEB_UI_UNAVAILABLE', '번들 UI 산출물이 없거나 사용할 수 없습니다. 먼저 npm run build:web을 실행하세요.');
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppError('WEB_UI_UNAVAILABLE', '번들 UI 산출물이 없습니다. 먼저 npm run build:web을 실행하세요.');
    }
    throw error;
  }
  const canonical = realpathSync(target);
  if (relative(root, canonical) !== join('dist', 'web')) {
    throw new AppError('WEB_UI_UNAVAILABLE', '번들 UI 경로가 올바르지 않습니다.');
  }
  const index = join(canonical, 'index.html');
  try {
    const stat = lstatSync(index);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
      throw new AppError('WEB_UI_UNAVAILABLE', '번들 UI의 index.html을 사용할 수 없습니다.');
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('WEB_UI_UNAVAILABLE', '번들 UI의 index.html이 없습니다. 먼저 npm run build:web을 실행하세요.');
  }
  const html = readFileSync(index, 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]!);
  if (!/<head[\s>]/i.test(html) || !/id="root"/.test(html) || !scripts.length) {
    throw new AppError('WEB_UI_UNAVAILABLE', '번들 UI의 index.html 형식이 올바르지 않습니다. 다시 빌드하세요.');
  }
  for (const asset of [...scripts, ...[...html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)].map((match) => match[1]!)]) {
    try { if (!confinedFile(canonical, asset)) throw new Error('Invalid asset'); }
    catch { throw new AppError('WEB_UI_UNAVAILABLE', '번들 UI가 참조한 산출물이 없거나 부적합합니다. 다시 빌드하세요.'); }
  }
  return canonical;
}

function confinedFile(root: string, pathname: string) {
  if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.includes('\\')) return;
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); }
  catch { return; }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.includes('%') || decoded.includes(':')) return;
  const relativePath = decoded === '/' ? 'index.html' : decoded.slice(1);
  if (!relativePath || relativePath.endsWith('/') || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) return;
  const target = resolve(root, relativePath);
  const part = relative(root, target);
  if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) return;
  let cursor = root;
  const components = part.split(sep);
  for (const [index, component] of components.entries()) {
    cursor = join(cursor, component);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) return;
    if (index === components.length - 1) {
      if (!stat.isFile() || stat.nlink > 1) return;
      const type = TYPES[extname(cursor).toLowerCase()];
      if (!type) return;
      return { path: cursor, type };
    }
    if (!stat.isDirectory()) return;
  }
}

export function serveWebAsset(
  webRoot: string,
  request: IncomingMessage,
  response: ServerResponse,
  injectHtml?: (html: string) => string,
) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
    response.end();
    return true;
  }
  let pathname: string;
  try {
    const raw = request.url ?? '/';
    if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('?') || raw.includes('#')) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('Not found');
      return true;
    }
    pathname = raw;
  } catch {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('Bad request');
    return true;
  }
  let asset: { path: string; type: string } | undefined;
  try { asset = confinedFile(webRoot, pathname); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!asset) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('Not found');
    return true;
  }
  if (asset.type.startsWith('text/html') && injectHtml) {
    const body = injectHtml(readFileSync(asset.path, 'utf8'));
    response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
    response.end(request.method === 'HEAD' ? undefined : body);
    return true;
  }
  const stat = lstatSync(asset.path);
  response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store', 'Content-Length': stat.size });
  if (request.method === 'HEAD') { response.end(); return true; }
  const stream = createReadStream(asset.path);
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
  return true;
}
