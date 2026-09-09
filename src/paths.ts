import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { ChatError as AppError } from './chat-contract.js';

export function checkoutRoot(fromModuleUrl: string) {
  return realpathSync(new URL('../', fromModuleUrl));
}

export function resolveWorkspaceDirectory(projectRoot: string, directory: string) {
  try { return workspacePath(resolve(realpathSync(projectRoot), directory)); }
  catch { throw new AppError('INVALID_WORKSPACE', 'Workspace는 접근 가능한 기존 폴더여야 합니다.'); }
}

// Development data stays in this checkout. No automatic user-profile writes.
export function prepareDataDirectory(projectRoot: string, directory: string) {
  return resolveDataDirectory(projectRoot, directory, true);
}

function resolveDataDirectory(projectRoot: string, directory: string, create: boolean) {
  const root = realpathSync(projectRoot);
  const target = resolve(root, directory);
  const part = relative(root, target);
  if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) {
    throw new AppError('INVALID_DATA_PATH', '개발 데이터 경로는 프로젝트 내부의 별도 디렉터리여야 합니다.');
  }
  let cursor = root;
  for (const component of part.split(sep)) {
    cursor = join(cursor, component);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new AppError('INVALID_DATA_PATH', '데이터 경로에 링크나 일반 파일을 사용할 수 없습니다.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) throw new AppError('DATA_NOT_FOUND', '지정한 데이터 영역이 없습니다.');
      mkdirSync(cursor, { mode: 0o700 });
    }
  }
  return realpathSync(target);
}

export function assertUnlinkedFile(path: string, message = '데이터 파일의 링크나 파일 형식이 올바르지 않습니다.') {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
    throw new AppError('INVALID_DATA_PATH', message);
  }
  return stat;
}

export function workspacePath(directory: string) {
  const canonical = realpathSync(directory);
  if (!lstatSync(canonical).isDirectory()) {
    throw new AppError('INVALID_WORKSPACE', 'Workspace는 기존 폴더여야 합니다.');
  }
  // Windows paths are insensitive to drive-letter case. Preserve the real path for display.
  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  if (!parse(canonical).root) throw new AppError('INVALID_WORKSPACE', 'Workspace 경로가 올바르지 않습니다.');
  return { path: canonical, key };
}
