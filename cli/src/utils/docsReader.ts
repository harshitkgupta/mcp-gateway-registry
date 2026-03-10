import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DOCS_DIR = path.resolve(__dirname, '../../..', 'docs');

export interface DocFile {
  path: string;
  name: string;
  content: string;
}


function _walkDirectory(dir: string, baseDir: string, files: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const resolvedBase = path.resolve(baseDir);

  for (const entry of entries) {
    // Validate entry name doesn't contain path traversal sequences
    if (entry.name.includes('..') || entry.name.includes('/') || entry.name.includes('\\')) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);

    // Ensure resolved path is still within baseDir
    const resolvedPath = path.resolve(fullPath);
    if (!resolvedPath.startsWith(resolvedBase)) {
      continue;
    }

    if (entry.isDirectory()) {
      _walkDirectory(fullPath, baseDir, files);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const relativePath = path.relative(baseDir, fullPath);
      files.push(relativePath);
    }
  }

  return files;
}


function _scoreDocument(content: string, fileName: string, keywords: string[]): number {
  let score = 0;
  const lowerContent = content.toLowerCase();
  const lowerFileName = fileName.toLowerCase();

  for (const keyword of keywords) {
    const lowerKeyword = keyword.toLowerCase();

    // Count occurrences in content
    const contentMatches = (lowerContent.match(new RegExp(lowerKeyword, 'g')) || []).length;
    score += contentMatches;

    // Boost score if keyword appears in filename or path
    if (lowerFileName.includes(lowerKeyword)) {
      score += 10;
    }
  }

  return score;
}


export function getAllDocFiles(): string[] {
  if (!fs.existsSync(DOCS_DIR)) {
    return [];
  }

  return _walkDirectory(DOCS_DIR, DOCS_DIR);
}


export function readDocFile(filePath: string): DocFile | null {
  // Reject path traversal sequences and absolute paths
  if (filePath.includes('..') || path.isAbsolute(filePath)) {
    throw new Error(`Invalid file path: ${filePath}`);
  }

  const fullPath = path.join(DOCS_DIR, filePath);

  // Resolve paths and ensure result is within DOCS_DIR
  const resolvedPath = path.resolve(fullPath);
  const resolvedBase = path.resolve(DOCS_DIR);
  if (!resolvedPath.startsWith(resolvedBase)) {
    throw new Error(`Path traversal detected: ${filePath}`);
  }

  if (!fs.existsSync(resolvedPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    const name = path.basename(filePath);

    return {
      path: filePath,
      name,
      content
    };
  } catch (error) {
    return null;
  }
}


export function searchDocs(query: string): DocFile[] {
  const keywords = query.trim().split(/\s+/).filter(k => k.length > 0);

  if (keywords.length === 0) {
    return [];
  }

  const allFiles = getAllDocFiles();
  const scoredDocs: Array<{ doc: DocFile; score: number }> = [];

  for (const filePath of allFiles) {
    const doc = readDocFile(filePath);
    if (!doc) continue;

    const score = _scoreDocument(doc.content, doc.path, keywords);

    if (score > 0) {
      scoredDocs.push({ doc, score });
    }
  }

  // Sort by score descending and return top 3
  scoredDocs.sort((a, b) => b.score - a.score);

  return scoredDocs.slice(0, 3).map(item => item.doc);
}
