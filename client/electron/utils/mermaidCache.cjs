const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getGeneratedImagesDir } = require('./paths.cjs');

const MERMAID_CACHE_DIR_NAME = 'mermaid-cache';
const MERMAID_CACHE_VERSION = 5;
const MERMAID_CACHE_OUTPUT_TYPE = 'png';
const MERMAID_CACHE_THEME = 'default';
const MERMAID_CACHE_BG_COLOR = '!white';

function normalizeMermaidCode(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

function createMermaidCacheHash(code, options = {}) {
  const payload = {
    version: MERMAID_CACHE_VERSION,
    outputType: MERMAID_CACHE_OUTPUT_TYPE,
    theme: options.theme || MERMAID_CACHE_THEME,
    bgColor: options.bgColor || MERMAID_CACHE_BG_COLOR,
    code: normalizeMermaidCode(code),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

// T10：options.generatedImagesRoot 允许项目化调用方（持全局 app 的 exportService）显式指定资产根；
// 缺省沿用 app 推导——全局 app 得全局根，项目 app 代理（projectStoreRegistry 构造 store 时传入）得项目根。
function getMermaidCacheDir(app, options = {}) {
  const imagesRoot = options.generatedImagesRoot || getGeneratedImagesDir(app);
  return path.join(imagesRoot, MERMAID_CACHE_DIR_NAME);
}

function getMermaidCacheFilePath(app, hash, options = {}) {
  return path.join(getMermaidCacheDir(app, options), `${hash}.png`);
}

function getMermaidCacheAssetUrl(hash) {
  return `yibiao-asset://generated-images/${encodeURIComponent(MERMAID_CACHE_DIR_NAME)}/${encodeURIComponent(`${hash}.png`)}?pixel-density=3`;
}

function getMermaidCacheEntry(app, code, options = {}) {
  const normalizedCode = normalizeMermaidCode(code);
  const hash = createMermaidCacheHash(normalizedCode, options);
  const filePath = getMermaidCacheFilePath(app, hash, options);
  return {
    hash,
    code: normalizedCode,
    filePath,
    assetUrl: getMermaidCacheAssetUrl(hash),
    exists: fs.existsSync(filePath),
  };
}

function saveMermaidCacheImage(app, hash, buffer, options = {}) {
  if (!buffer?.length) return null;
  const cacheDir = getMermaidCacheDir(app, options);
  fs.mkdirSync(cacheDir, { recursive: true });
  const filePath = getMermaidCacheFilePath(app, hash, options);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  fs.renameSync(tempPath, filePath);
  return {
    filePath,
    assetUrl: getMermaidCacheAssetUrl(hash),
  };
}

function clearMermaidCache(app) {
  const cacheDir = getMermaidCacheDir(app);
  if (fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

module.exports = {
  clearMermaidCache,
  getMermaidCacheEntry,
  getMermaidCacheDir,
  getMermaidCacheAssetUrl,
  normalizeMermaidCode,
  saveMermaidCacheImage,
};
